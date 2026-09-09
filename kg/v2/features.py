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
    sort_sql = {
        "name": "display_name",
        "author": "coalesce(author,'')",
        "authored_at": "coalesce(authored_at,'')",
        "registered_at": "registered_at",
    }[sort]
    sql = """SELECT x.*,""" + sort_sql + """ sort_value FROM (
      SELECT d.document_id,d.display_name,d.provider,d.file_type,d.current_version_id,d.registered_at,
        v.author,v.authored_at,
        CASE WHEN o.access_id IS NULL THEN 'unknown' WHEN o.expires_at<=? THEN 'expired'
          WHEN o.can_view=1 THEN 'allowed' ELSE 'denied' END access_status,
        CASE
          WHEN NOT EXISTS(SELECT 1 FROM template_application a WHERE a.document_version_id=d.current_version_id) THEN 'unassigned'
          WHEN EXISTS(SELECT 1 FROM template_application a JOIN extraction_run e USING(application_id) WHERE a.document_version_id=d.current_version_id AND e.status='failed' AND e.created_at=(SELECT max(z.created_at) FROM extraction_run z WHERE z.application_id=a.application_id)) THEN 'failed'
          WHEN NOT EXISTS(SELECT 1 FROM template_application a WHERE a.document_version_id=d.current_version_id AND a.published_run_id IS NULL) THEN 'published'
          WHEN EXISTS(SELECT 1 FROM mapping_revision m WHERE m.document_version_id=d.current_version_id AND m.status<>'approved' AND m.revision_no=(SELECT max(z.revision_no) FROM mapping_revision z WHERE z.application_id=m.application_id AND z.rule_key=m.rule_key)) THEN 'review'
          ELSE 'pending' END extraction_status
      FROM document d LEFT JOIN document_version v ON v.document_version_id=d.current_version_id
      LEFT JOIN access_observation o ON o.access_id=(SELECT z.access_id FROM access_observation z
        WHERE z.document_version_id=d.current_version_id AND z.principal_ref=? ORDER BY z.checked_at DESC,z.access_id DESC LIMIT 1)
      WHERE d.display_name LIKE ? AND coalesce(v.author,'') LIKE ?
    """
    params = [now(), user, "%" + q + "%", "%" + author + "%"]
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
