"""페이지 조회·검수 이력·수동 KG 편집. 기존 불변 버전은 직접 수정하지 않는다."""

from __future__ import annotations

import json
from .db import Problem, dump, now, one


def selection_cte(kg, roots, excluded):
    """화면에서 펼치지 않은 하위 개념도 선택한다. UNION으로 다부모 중복을 제거한다."""
    if len(roots) > 100 or len(excluded) > 100:
        raise Problem(
            "SELECTION_LIMIT",
            "선택/제외할 기준 개념은 각각 100개 이하여야 합니다.",
            413,
        )

    def seed(ids):
        return ",".join("?" for _ in ids) or "NULL"

    sql = f"""WITH RECURSIVE
      chosen(id) AS (SELECT concept_id FROM domain_concept WHERE kg_revision_id=? AND concept_id IN ({seed(roots)})
        UNION SELECT e.to_concept_id FROM domain_edge e JOIN chosen c ON c.id=e.from_concept_id WHERE e.kg_revision_id=? AND e.relation_type='parent_of'),
      omitted(id) AS (SELECT concept_id FROM domain_concept WHERE kg_revision_id=? AND concept_id IN ({seed(excluded)})
        AND concept_id NOT IN ({seed(roots) if roots else "''"})
        UNION SELECT e.to_concept_id FROM domain_edge e JOIN omitted c ON c.id=e.from_concept_id WHERE e.kg_revision_id=? AND e.relation_type='parent_of' AND e.to_concept_id NOT IN ({seed(roots) if roots else "''"})),
      selected(id) AS (SELECT id FROM chosen EXCEPT SELECT id FROM omitted) """
    return sql, (kg, *roots, kg, kg, *excluded, *roots, kg, *roots)


# 목록의 문서군·템플릿 요약. 메타데이터만 읽고 원본 파일은 열지 않는다(db-schema-v2 §4/§6).
# 페이지 SQL(document_query)은 정렬 키에 필요한 값(first_template, review_pending)만 인덱스로 계산하고,
# templates[]·roots[]는 페이지 행에 대해서만 document_summary_query()가 같은 읽기 트랜잭션의 두 번째 SQL로 계산한다
# (말뭉치 전체를 훑는 CTE를 매 요청에 붙이지 않는다).
# 문서군 = coverage_graph()와 같은 뿌리 규칙: 현재 문서 버전의 현재 발행 실행에 추출된 개념을 매핑이 고정된 KG 리비전의
# parent_of 간선으로 L1까지 올린 뿌리(각 단계에서 level-1인 활성 부모 중 concept_id가 가장 작은 것; 폐기 개념은 사슬을 끊는다).
# 뿌리 이름도 고정된 KG 리비전의 이름이다(문서가 여러 고정 리비전에 걸치면 가장 새 고정 리비전) = GET /kg/{pinned}/graph의 group.
# 그래프 화면의 NODE_CAP(2000) 절단은 적용하지 않는다 — 그래프가 `truncated`인 KG에서는 목록이 그래프가 떨어뜨린
# 뿌리를 보여줄 수 있다(의도된 유일한 차이).
# SQLite 3.44 전용 집계 ORDER BY는 쓰지 않는다: 순서 번호 rn을 JSON에 넣고 api.py가 정렬 후 제거한다.
ROOT_CAP = 8
# 미승인 헤드 = (application_id, rule_key)별 max(revision_no)가 approved가 아닌 규칙(db-schema-v2 §6).
# UNIQUE(application_id, rule_key, revision_no) 자동 인덱스를 타므로 mapping_revision 전체 스캔이 없다.
PENDING_HEADS = """(SELECT count(*) FROM mapping_revision m WHERE m.application_id=a.application_id AND m.status<>'approved'
   AND m.revision_no=(SELECT max(z.revision_no) FROM mapping_revision z WHERE z.application_id=m.application_id AND z.rule_key=m.rule_key))"""
# 문서 단위: template_application(app_source 인덱스)을 거쳐 적용 건별 헤드를 센다. 복합 FK로 m.document_version_id=a.document_version_id.
DOCUMENT_PENDING_HEADS = """(SELECT count(*) FROM template_application a JOIN mapping_revision m ON m.application_id=a.application_id
   WHERE a.document_version_id=d.current_version_id AND m.status<>'approved'
   AND m.revision_no=(SELECT max(z.revision_no) FROM mapping_revision z WHERE z.application_id=m.application_id AND z.rule_key=m.rule_key))"""
SUMMARY_CTES = """WITH RECURSIVE
page(document_id, version_id) AS (
  SELECT document_id, current_version_id FROM document WHERE document_id IN ({ids})
),
apps AS (
  SELECT application_id, document_version_id, scope_key, template_id, template_version_id, name, revision_no, review_pending,
    CASE WHEN failed THEN 'failed' WHEN published THEN 'published' WHEN review_pending>0 THEN 'review' ELSE 'pending' END state,
    row_number() OVER (PARTITION BY document_version_id ORDER BY name, revision_no, application_id) rn
  FROM (
    SELECT a.application_id, a.document_version_id, a.scope_key, tv.template_id, a.template_version_id, t.name, tv.revision_no,
      EXISTS(SELECT 1 FROM extraction_run e WHERE e.application_id=a.application_id AND e.status='failed'
             AND e.created_at=(SELECT max(z.created_at) FROM extraction_run z WHERE z.application_id=a.application_id)) failed,
      a.published_run_id IS NOT NULL published,
      """ + PENDING_HEADS + """ review_pending
    FROM page p JOIN template_application a ON a.document_version_id=p.version_id
    JOIN template_version tv ON tv.template_version_id=a.template_version_id
    JOIN template t ON t.template_id=tv.template_id
  )
),
cov AS (
  SELECT DISTINCT p.document_id, m.kg_revision_id kg, m.concept_id
  FROM page p
  JOIN template_application a ON a.document_version_id=p.version_id AND a.published_run_id IS NOT NULL
  JOIN extraction_run r ON r.run_id=a.published_run_id AND r.status='succeeded'
  JOIN extracted_series s ON s.run_id=r.run_id AND s.document_version_id=p.version_id
  JOIN mapping_revision m ON m.mapping_revision_id=s.mapping_revision_id AND m.application_id=a.application_id
  WHERE m.concept_id IS NOT NULL
),
climb(kg, start, cid, lvl) AS (
  SELECT cov.kg, cov.concept_id, cov.concept_id, c.level FROM cov
  CROSS JOIN domain_concept c ON c.kg_revision_id=cov.kg AND c.concept_id=cov.concept_id AND c.status='active'
  UNION ALL
  SELECT u.kg, u.start,
    (SELECT min(e.from_concept_id) FROM domain_edge e
       JOIN domain_concept p ON p.kg_revision_id=e.kg_revision_id AND p.concept_id=e.from_concept_id AND p.status='active' AND p.level=u.lvl-1
     WHERE e.kg_revision_id=u.kg AND e.to_concept_id=u.cid AND e.relation_type='parent_of'),
    u.lvl-1
  FROM climb u WHERE u.lvl>1 AND u.cid IS NOT NULL
),
-- CROSS JOIN은 SQLite의 조인 순서 힌트: 페이지 범위의 cov를 바깥 루프로 두고 domain_concept는 PK로만 찾는다.
doc_root_kg AS (
  SELECT document_id, root_id, kg,
    row_number() OVER (PARTITION BY document_id, root_id ORDER BY revision_no DESC) k
  FROM (
    SELECT DISTINCT cov.document_id, u.cid root_id, u.kg, r.revision_no
    FROM cov JOIN climb u ON u.kg=cov.kg AND u.start=cov.concept_id AND u.lvl=1 AND u.cid IS NOT NULL
    JOIN kg_revision r ON r.kg_revision_id=u.kg
  )
),
doc_root AS (
  SELECT document_id, root_id, name,
    row_number() OVER (PARTITION BY document_id ORDER BY name, root_id) rn
  FROM (
    SELECT x.document_id, x.root_id,
      (SELECT c.name FROM domain_concept c WHERE c.kg_revision_id=x.kg AND c.concept_id=x.root_id) name
    FROM doc_root_kg x WHERE x.k=1
  )
)
"""


def document_summary_query(document_ids):
    """페이지 문서들의 templates[]·template_count·roots[]·root_count. 페이지 행(≤100)에만 바인딩된다."""
    ids = ",".join("?" for _ in document_ids)
    sql = (
        SUMMARY_CTES.replace("{ids}", ids)
        + """SELECT p.document_id,
      (SELECT json_group_array(json_object('application_id',application_id,'scope_key',scope_key,'template_id',template_id,
         'template_version_id',template_version_id,'name',name,'revision_no',revision_no,'state',state,'review_pending',review_pending,'rn',rn))
         FROM apps WHERE apps.document_version_id=p.version_id) templates_json,
      (SELECT count(*) FROM apps WHERE apps.document_version_id=p.version_id) template_count,
      (SELECT json_group_array(json_object('concept_id',root_id,'name',name,'rn',rn)) FROM doc_root g
         WHERE g.document_id=p.document_id AND g.rn<="""
        + str(ROOT_CAP)
        + """) roots_json,
      (SELECT count(*) FROM doc_root g WHERE g.document_id=p.document_id) root_count
    FROM page p"""
    )
    return sql, tuple(document_ids)


def document_query(
    user,
    q,
    author,
    date_from,
    date_to,
    access_status,
    extraction_status,
    template,
    sort,
):
    # 접근 필터는 마지막 권한 관찰을 사용한다. 목록에서 원본 전체를 다시 열지 않는다.
    # 정렬 값은 커서 키이므로 NULL이 나오면 안 된다(str|int만 커서로 복원된다).
    sort_sql = {
        "name": "display_name",
        "author": "coalesce(author,'')",
        "authored_at": "coalesce(authored_at,'')",
        "registered_at": "registered_at",
        # 미배정 문서는 '1' 표지로 오름차순 마지막(내림차순 첫째)에 온다. 단일 키 keyset이라 방향별 nulls-last는 없다.
        "template": "CASE WHEN first_template IS NULL THEN '1' ELSE '0'||first_template END",
        "review": "review_pending",
    }[sort]
    # template= 필터가 있으면 정렬 키도 필터에 맞는 첫 템플릿(apps.rn과 같은 순서)이다. templates[]는 이름순 그대로다.
    sql = (
        """SELECT x.*,"""
        + sort_sql
        + """ sort_value FROM (
      SELECT d.document_id,d.display_name,d.provider,d.file_type,d.current_version_id,d.registered_at,
        v.author,v.authored_at,
        CASE WHEN o.access_id IS NULL THEN 'unknown' WHEN o.expires_at<=? THEN 'expired'
          WHEN o.can_view=1 THEN 'allowed' ELSE 'denied' END access_status,
        CASE
          WHEN NOT EXISTS(SELECT 1 FROM template_application a WHERE a.document_version_id=d.current_version_id) THEN 'unassigned'
          WHEN EXISTS(SELECT 1 FROM template_application a JOIN extraction_run e USING(application_id) WHERE a.document_version_id=d.current_version_id AND e.status='failed' AND e.created_at=(SELECT max(z.created_at) FROM extraction_run z WHERE z.application_id=a.application_id)) THEN 'failed'
          WHEN NOT EXISTS(SELECT 1 FROM template_application a WHERE a.document_version_id=d.current_version_id AND a.published_run_id IS NULL) THEN 'published'
          WHEN """
        + DOCUMENT_PENDING_HEADS
        + """>0 THEN 'review'
          ELSE 'pending' END extraction_status,
        (SELECT t.name FROM template_application a JOIN template_version tv ON tv.template_version_id=a.template_version_id
           JOIN template t ON t.template_id=tv.template_id WHERE a.document_version_id=d.current_version_id"""
        + (" AND t.name LIKE ?" if template else "")
        + """ ORDER BY t.name, tv.revision_no, a.application_id LIMIT 1) first_template,
        """
        + DOCUMENT_PENDING_HEADS
        + """ review_pending
      FROM document d LEFT JOIN document_version v ON v.document_version_id=d.current_version_id
      LEFT JOIN access_observation o ON o.access_id=(SELECT z.access_id FROM access_observation z
        WHERE z.document_version_id=d.current_version_id AND z.principal_ref=? ORDER BY z.checked_at DESC,z.access_id DESC LIMIT 1)
      WHERE d.display_name LIKE ? AND coalesce(v.author,'') LIKE ?
    """
    )
    # 바인딩 순서 = SQL 등장 순서: now, [first_template LIKE], user, q, author, ...
    params = [now()]
    if template:
        params.append("%" + template + "%")
    params += [user, "%" + q + "%", "%" + author + "%"]
    if date_from:
        sql += " AND substr(v.authored_at,1,10)>=?"
        params.append(str(date_from))
    if date_to:
        sql += " AND substr(v.authored_at,1,10)<=?"
        params.append(str(date_to))
    if template:
        sql += " AND EXISTS(SELECT 1 FROM template_application a JOIN template_version tv USING(template_version_id) JOIN template t USING(template_id) WHERE a.document_version_id=d.current_version_id AND t.name LIKE ?)"
        params.append("%" + template + "%")
    sql += ") x WHERE 1=1"
    if access_status:
        sql += " AND access_status=?"
        params.append(access_status)
    if extraction_status:
        sql += " AND extraction_status=?"
        params.append(extraction_status)
    return sql, tuple(params)


def record_access(service, version, principal, caps):
    from .db import insert, uid

    flags = [
        int(bool(caps.get(k)))
        for k in ("can_view", "can_extract", "can_render_web", "can_cache_derivative")
    ]
    checked = now()
    expires = str(caps.get("expires_at") or checked)
    with service.db.connect(write=True) as conn:
        insert(
            conn,
            "access_observation",
            access_id=uid(),
            document_version_id=version["document_version_id"],
            principal_ref=principal,
            provider=version["provider"],
            policy_revision=str(caps.get("policy_revision", "unknown")),
            can_view=flags[0],
            can_extract=flags[1],
            can_render_web=flags[2],
            can_cache_derivative=flags[3],
            checked_at=checked,
            expires_at=expires,
        )


def rollback(service, aid, current_id, body, user):
    current, target = service.mapping(current_id), service.mapping(
        body["target_revision_id"]
    )
    if (
        current["application_id"] != aid
        or target["application_id"] != aid
        or current["rule_key"] != target["rule_key"]
    ):
        raise Problem(
            "REVISION_SCOPE_MISMATCH",
            "같은 적용 건·규칙의 이력만 복원할 수 있습니다.",
            409,
        )
    return service.revise(
        aid,
        current_id,
        body["expected_seq"],
        target["effective_spec"],
        target["concept_id"],
        target["status"],
        body["reason"],
        user,
    )


def edit_concept(service, kg, cid, body, user):
    # 전체 KG 재입력 없이 한 개념을 편집하되, 발행은 동일한 불변 스냅샷 경로를 쓴다.
    with service.db.connect(write=True) as conn:
        latest = one(
            conn, "SELECT * FROM kg_revision ORDER BY revision_no DESC LIMIT 1"
        )
        if body["expected_revision_id"] != kg or latest["kg_revision_id"] != kg:
            raise Problem(
                "KG_EDIT_CONFLICT",
                "새 KG 버전이 있습니다. 최신 버전에서 다시 편집하세요.",
                409,
            )
        concepts = [
            dict(r)
            for r in conn.execute(
                "SELECT * FROM domain_concept WHERE kg_revision_id=? ORDER BY concept_id",
                (kg,),
            )
        ]
        found = False
        for concept in concepts:
            concept.pop("kg_revision_id")
            concept["aliases"] = [
                {"text": r["alias_text"], "context": json.loads(r["context_json"])}
                for r in conn.execute(
                    "SELECT * FROM domain_alias WHERE kg_revision_id=? AND concept_id=? ORDER BY alias_norm,context_key",
                    (kg, concept["concept_id"]),
                )
            ]
            if concept["concept_id"] == cid:
                found = True
                for key in ("name", "definition", "status"):
                    if body.get(key) is not None:
                        concept[key] = body[key]
                # 단건 추가는 기존 문맥 있는 동의어도 보존한다.
                concept["aliases"].extend(body.get("aliases") or [])
        if not found:
            raise Problem("NOT_FOUND", "개념을 찾을 수 없습니다.", 404)
        edges = {
            (r["from_concept_id"], r["to_concept_id"], r["relation_type"])
            for r in conn.execute(
                "SELECT * FROM domain_edge WHERE kg_revision_id=?", (kg,)
            )
        }
        for field, adding in (("add_relations", True), ("remove_relations", False)):
            for edge in body.get(field, []):
                item = (edge["from"], edge["to"], edge["type"])
                if cid not in item[:2]:
                    raise Problem("RELATION_SCOPE", "선택한 개념의 관계만 편집하세요.")
                if adding:
                    edges.add(item)
                else:
                    edges.discard(item)
        definition = {
            "concepts": concepts,
            "relations": [list(e) for e in sorted(edges)],
        }
        # import_kg의 트랜잭션을 재사용하여 최신 리비전 검사와 발행을 한 쓰기로 묶는다.
        return service.import_kg(definition, user, connection=conn)
