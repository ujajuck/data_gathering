"""완료된 빌드 산출물(사용자 SQLite DB)과 manifest를 DVC 추적 가능한 폴더로 내보낸다.

활성 v2.db와 DRM 원본은 절대 복사하지 않는다(docs/design/db-schema-v2.md §10). 빌드 파일은 발행 후 불변이므로
파일 복사가 곧 불변 export다. 모든 입력 원본의 접근 권한을 내보내기 전에 다시 확인한다(§8).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sqlite3
from pathlib import Path

from .build import authorize_build, output_path
from .db import Problem, dump, insert, now, uid
from .readers import file_hash
from .service import ENGINE_VERSION

EXPORT_FORMAT = "data-gathering-v2-export/1"
MANIFEST_NAME = "manifest.json"
SOURCE_POLICY_NOTE = (
    "DRM 원본과 활성 v2.db는 포함하지 않는다. 재실행은 제공자의 당시 버전 접근 가능성에 의존한다."
)


def dataset_filename(build_id: str) -> str:
    # api.py의 다운로드 파일 이름과 동일하다.
    return "custom-db-" + build_id + ".sqlite"


def _loads(text):
    return json.loads(text) if text else None


def _collect(service, build_id: str) -> dict:
    with service.db.connect() as conn:
        build = conn.execute(
            "SELECT b.*, a.artifact_id AS dataset_artifact_id, a.sha256 AS dataset_sha256, "
            "a.byte_size AS dataset_byte_size, a.media_type, a.policy_ref "
            "FROM build_run b JOIN artifact a ON a.artifact_id=b.output_artifact_id "
            "WHERE b.build_id=? AND b.status='succeeded'",
            (build_id,),
        ).fetchone()
        if build is None:
            raise Problem("NOT_FOUND", "완료된 빌드를 찾을 수 없습니다.", 404)
        build = dict(build)
        version = dict(
            conn.execute(
                "SELECT v.integration_version_id, v.revision_no, v.kg_revision_id, v.spec_sha256, v.created_at, "
                "p.project_id, p.name AS project_name FROM integration_version v "
                "JOIN integration_project p USING(project_id) WHERE v.integration_version_id=?",
                (build["integration_version_id"],),
            ).fetchone()
        )
        fields = [
            dict(r)
            for r in conn.execute(
                "SELECT field_key, concept_id, output_name, ordinal, target_type, target_unit "
                "FROM integration_field WHERE integration_version_id=? ORDER BY ordinal",
                (version["integration_version_id"],),
            )
        ]
        kg = dict(
            conn.execute(
                "SELECT kg_revision_id, revision_no, content_sha256, created_at FROM kg_revision WHERE kg_revision_id=?",
                (version["kg_revision_id"],),
            ).fetchone()
        )
        runs = []
        template_ids, version_ids = [], []
        for row in conn.execute(
            "SELECT bi.run_id, bi.selection_json, r.application_id, r.document_version_id, r.template_version_id, "
            "r.request_key, r.input_fingerprint, r.engine_version, r.environment_json, r.status, r.created_at, r.finished_at "
            "FROM build_input bi JOIN extraction_run r USING(run_id) WHERE bi.build_id=? ORDER BY bi.run_id",
            (build_id,),
        ):
            row = dict(row)
            mappings = [
                dict(m)
                for m in conn.execute(
                    "SELECT rule_key, mapping_revision_id FROM run_mapping WHERE run_id=? ORDER BY rule_key",
                    (row["run_id"],),
                )
            ]
            runs.append(
                {
                    "run_id": row["run_id"],
                    "application_id": row["application_id"],
                    "document_version_id": row["document_version_id"],
                    "template_version_id": row["template_version_id"],
                    "request_key": row["request_key"],
                    "input_fingerprint": row["input_fingerprint"],
                    "engine_version": row["engine_version"],
                    "environment": _loads(row["environment_json"]),
                    "status": row["status"],
                    "created_at": row["created_at"],
                    "finished_at": row["finished_at"],
                    "selection": _loads(row["selection_json"]),
                    "mappings": mappings,
                }
            )
            if row["template_version_id"] not in template_ids:
                template_ids.append(row["template_version_id"])
            if row["document_version_id"] not in version_ids:
                version_ids.append(row["document_version_id"])
        templates = [
            dict(
                conn.execute(
                    "SELECT tv.template_version_id, tv.template_id, t.name, tv.revision_no, tv.kg_revision_id, "
                    "tv.format, tv.definition_sha256, tv.engine_contract_version "
                    "FROM template_version tv JOIN template t USING(template_id) WHERE tv.template_version_id=?",
                    (tid,),
                ).fetchone()
            )
            for tid in sorted(template_ids)
        ]
        # document.source_ref/artifact.storage_ref는 서버 전용 불투명 참조라 manifest에 넣지 않는다.
        documents = [
            dict(
                conn.execute(
                    "SELECT v.document_version_id, v.document_id, d.display_name, d.provider, v.revision_no, v.filename, "
                    "v.provider_version_token, v.ciphertext_sha256, v.content_sha256, v.byte_size, v.captured_at "
                    "FROM document_version v JOIN document d USING(document_id) WHERE v.document_version_id=?",
                    (vid,),
                ).fetchone()
            )
            for vid in sorted(version_ids)
        ]
    return {
        "build": build,
        "integration": {**version, "fields": fields},
        "kg_revision": kg,
        "template_versions": templates,
        "extraction_runs": runs,
        "document_versions": documents,
    }


def _dataset_manifest(path: Path) -> dict:
    disk = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        row = disk.execute("SELECT json FROM _manifest").fetchone()
    finally:
        disk.close()
    if row is None:
        raise Problem("EXPORT_MANIFEST_MISMATCH", "빌드 산출물에 manifest가 없습니다.", 409)
    return json.loads(row[0])


def export_build(service, build_id: str, out, principal: str) -> dict:
    authorize_build(service, build_id, principal)
    source = output_path(service, build_id)
    out = Path(out).resolve()
    if out.exists() and any(out.iterdir()):
        raise Problem("EXPORT_EXISTS", "이미 내보낸 폴더입니다. 새 폴더를 지정하세요.", 409)
    collected = _collect(service, build_id)
    build = collected["build"]
    out.mkdir(parents=True, exist_ok=True)
    dataset = out / dataset_filename(build_id)
    manifest_path = out / MANIFEST_NAME
    written = []
    try:
        shutil.copyfile(source, dataset)
        written.append(dataset)
        dataset_sha = file_hash(dataset)
        if dataset_sha != build["dataset_sha256"]:
            raise Problem(
                "EXPORT_HASH_MISMATCH", "빌드 산출물이 등록된 해시와 다릅니다.", 409
            )
        dataset_manifest = _dataset_manifest(dataset)
        if dataset_manifest.get("build_id") != build_id:
            raise Problem(
                "EXPORT_MANIFEST_MISMATCH", "빌드 산출물의 manifest가 다른 빌드를 가리킵니다.", 409
            )
        manifest = {
            "format": EXPORT_FORMAT,
            "exported_at": now(),
            "engine_version": ENGINE_VERSION,
            "schema_version": 2,
            "build": {
                "build_id": build["build_id"],
                "integration_version_id": build["integration_version_id"],
                "status": build["status"],
                "input_fingerprint": build["input_fingerprint"],
                "input_manifest": _loads(build["input_manifest_json"]),
                "row_count": build["row_count"],
                "created_at": build["created_at"],
                "finished_at": build["finished_at"],
            },
            "integration": collected["integration"],
            "kg_revision": collected["kg_revision"],
            "template_versions": collected["template_versions"],
            "extraction_runs": collected["extraction_runs"],
            "document_versions": collected["document_versions"],
            "dataset": {
                "file": dataset.name,
                "artifact_id": build["dataset_artifact_id"],
                "sha256": dataset_sha,
                "byte_size": build["dataset_byte_size"],
                "media_type": build["media_type"],
                "policy_ref": build["policy_ref"],
                "dataset_manifest": dataset_manifest,
            },
            "source_policy": {
                "protected_sources_included": False,
                "note": SOURCE_POLICY_NOTE,
            },
        }
        text = json.dumps(manifest, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        manifest_path.write_text(text, encoding="utf-8")
        written.append(manifest_path)
        manifest_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        artifact_id = uid()
        with service.db.connect(write=True) as conn:
            insert(
                conn,
                "artifact",
                artifact_id=artifact_id,
                kind="manifest",
                storage_ref=str(out),
                sha256=manifest_sha,
                byte_size=len(text.encode("utf-8")),
                media_type="application/json",
                dvc_ref_json=dump(
                    {
                        "build_id": build_id,
                        "dataset_sha256": dataset_sha,
                        "manifest_sha256": manifest_sha,
                        "out": str(out),
                    }
                ),
                policy_ref="reauthorize-all-inputs",
                created_at=now(),
            )
    except BaseException:
        for path in written:
            path.unlink(missing_ok=True)
        raise
    return {
        "build_id": build_id,
        "out": str(out),
        "files": [MANIFEST_NAME, dataset.name],
        "dataset_sha256": dataset_sha,
        "manifest_sha256": manifest_sha,
        "manifest_artifact_id": artifact_id,
    }
