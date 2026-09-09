"""완료된 빌드의 DVC export 검증. 실제 DVC는 없으므로 폴더/manifest/dvc.yaml 구조만 검사한다."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from kg.v2.db import Problem, uid
from kg.v2.export import dataset_filename, export_build
from kg.v2.readers import file_hash
from tests.test_v2_runtime import extracted, integration, setup  # noqa: F401

ROOT = Path(__file__).resolve().parents[1]


def built(s):
    extracted(s)
    project = integration(s)
    build = s["work"]("/integrations/" + project["integration_version_id"] + "/build", {})
    assert build["state"] == "succeeded", build
    return build["result"]["build_id"], project


def test_export_copies_dataset_and_writes_manifest(setup, tmp_path):
    s = setup
    bid, project = built(s)
    out = tmp_path / "exp"
    result = export_build(s["service"], bid, out, "local-user")
    dataset = out / dataset_filename(bid)
    assert sorted(p.name for p in out.iterdir()) == sorted(["manifest.json", dataset.name])
    assert result["files"] == ["manifest.json", dataset.name]
    text = (out / "manifest.json").read_text(encoding="utf-8")
    manifest = json.loads(text)
    with s["service"].db.connect() as conn:
        artifact = conn.execute(
            "SELECT a.* FROM build_run b JOIN artifact a ON a.artifact_id=b.output_artifact_id WHERE b.build_id=?",
            (bid,),
        ).fetchone()
        template = conn.execute(
            "SELECT definition_sha256 FROM template_version WHERE template_version_id=?",
            (s["template"]["template_version_id"],),
        ).fetchone()
        run_mapping = conn.execute("SELECT rule_key, mapping_revision_id FROM run_mapping").fetchall()
        manifests = conn.execute("SELECT * FROM artifact WHERE kind='manifest'").fetchall()
    assert file_hash(dataset) == artifact["sha256"] == manifest["dataset"]["sha256"]
    assert result["dataset_sha256"] == artifact["sha256"]
    assert manifest["format"] == "data-gathering-v2-export/1" and manifest["schema_version"] == 2
    assert manifest["build"]["build_id"] == bid
    assert manifest["build"]["input_manifest"]["selections"][0]["rule_key"] == "temperature"
    assert manifest["integration"]["integration_version_id"] == project["integration_version_id"]
    assert manifest["integration"]["fields"][0]["output_name"] == "공정온도"
    assert manifest["template_versions"][0]["definition_sha256"] == template["definition_sha256"]
    assert manifest["template_versions"][0]["template_version_id"] == s["template"]["template_version_id"]
    assert manifest["extraction_runs"][0]["mappings"] == [
        {"rule_key": "temperature", "mapping_revision_id": run_mapping[0]["mapping_revision_id"]}
    ]
    assert manifest["extraction_runs"][0]["status"] == "succeeded"
    assert manifest["kg_revision"]["kg_revision_id"] == s["kg"]["kg_revision_id"]
    assert manifest["document_versions"][0]["document_version_id"] == s["doc"]["version_id"]
    assert manifest["document_versions"][0]["filename"] == "sample.xlsx"
    assert manifest["dataset"]["dataset_manifest"]["build_id"] == bid
    assert manifest["dataset"]["file"] == dataset.name
    assert manifest["source_policy"]["protected_sources_included"] is False
    assert "source_ref" not in text and "storage_ref" not in text
    assert len(manifests) == 1
    assert json.loads(manifests[0]["dvc_ref_json"])["build_id"] == bid
    assert manifests[0]["sha256"] == result["manifest_sha256"]
    assert manifests[0]["artifact_id"] == result["manifest_artifact_id"]
    assert manifests[0]["policy_ref"] == "reauthorize-all-inputs"


def test_export_rejects_unfinished_build_and_existing_dir(setup, tmp_path):
    s = setup
    extracted(s)
    project = integration(s)
    queued = s["api"](
        "POST",
        "/integrations/" + project["integration_version_id"] + "/build",
        {"request_key": uid()},
        202,
    )
    with pytest.raises(Problem) as unfinished:
        export_build(s["service"], queued["job_id"], tmp_path / "queued", "local-user")
    assert unfinished.value.code == "NOT_FOUND"
    assert not (tmp_path / "queued").exists() or not any((tmp_path / "queued").iterdir())
    s["service"].jobs.run_one()
    job = s["api"]("GET", "/jobs/" + queued["job_id"])
    assert job["state"] == "succeeded", job
    bid = job["result"]["build_id"]
    out = tmp_path / "twice"
    export_build(s["service"], bid, out, "local-user")
    with pytest.raises(Problem) as again:
        export_build(s["service"], bid, out, "local-user")
    assert again.value.code == "EXPORT_EXISTS" and again.value.status == 409
    assert sorted(p.name for p in out.iterdir()) == sorted(["manifest.json", dataset_filename(bid)])


def test_export_reauthorizes_sources(setup, tmp_path):
    s = setup
    bid, _ = built(s)
    s["path"].unlink()
    out = tmp_path / "gone"
    with pytest.raises(Problem) as denied:
        export_build(s["service"], bid, out, "local-user")
    assert denied.value.code == "SOURCE_NOT_FOUND"
    assert not out.exists() or not any(out.iterdir())
    with s["service"].db.connect() as conn:
        assert conn.execute("SELECT count(*) FROM artifact WHERE kind='manifest'").fetchone()[0] == 0


def test_cli_parse_keeps_serve_default_and_runs_export(setup, tmp_path, capsys):
    from kg.v2.__main__ import main, parse

    legacy = parse(["--ws", "x", "--port", "1"])
    assert legacy.command == "serve" and legacy.port == 1 and legacy.ws == Path("x")
    assert parse([]).command == "serve" and parse([]).port == 8010
    assert parse(["serve", "--host", "0.0.0.0"]).host == "0.0.0.0"
    s = setup
    bid, _ = built(s)
    out = tmp_path / "cli"
    main(["export", "--ws", str(s["service"].root), "--build", bid, "--out", str(out)])
    result = json.loads(capsys.readouterr().out)
    assert result["build_id"] == bid and (out / dataset_filename(bid)).exists()
    with pytest.raises(SystemExit) as failure:
        main(["export", "--ws", str(s["service"].root), "--build", bid, "--out", str(out)])
    assert failure.value.code == 2
    assert json.loads(capsys.readouterr().err)["error"]["code"] == "EXPORT_EXISTS"


def test_dvc_stage_excludes_live_db_and_raw_sources():
    config = yaml.safe_load((ROOT / "dvc.yaml").read_text(encoding="utf-8"))
    stage = config["stages"]["v2_export_build"]
    assert stage["cmd"].startswith("python -m kg.v2 export")
    assert set(config["vars"][0]["v2_export"]) == {"ws", "build_id", "out"}
    assert stage["outs"] == ["${v2_export.out}"]
    for name, spec in config["stages"].items():
        for path in spec.get("outs", []):
            assert "v2.db" not in path and "kg.db" not in path and "data/raw" not in path, name
        for path in spec.get("deps", []):
            assert "v2.db" not in path and "kg.db" not in path, name
    assert "data/raw" not in " ".join(stage["deps"])
