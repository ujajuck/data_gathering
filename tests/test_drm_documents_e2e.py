"""All repository documents through protected -> authorized unlock -> Viewer E2E.

The test never encrypts or decrypts a real file.  It converts temporary copies
into an OLE/DRM-shaped protected input, verifies every parser rejects them, then
models delivery from an authorized unlock service using the original fixtures.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from kg.acquisition import (create_request, mark_ingested,
                            refresh_release_states, sniff_container)
from kg.cli import Workspace
from kg.ingest import ingest_file
from kg.store import KgStore
from kg.viewer import (register_unlocked, render_preview, sha256_file, sheets,
                       source_locator)
from tests.conftest import REPO_ROOT

_OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def _protect_copy(path: Path) -> None:
    """Create a test-only protected container; this is not a DRM bypass tool."""
    path.write_bytes(_OLE_MAGIC + b"\x00" * 1024)


def _fake_soffice(path: Path) -> Path:
    path.write_text("""#!/usr/bin/env python3
import pathlib,sys
out = pathlib.Path(sys.argv[sys.argv.index('--outdir') + 1])
source = pathlib.Path(sys.argv[-1])
(out / (source.stem + '.pdf')).write_bytes(b'%PDF-1.4\\n%%EOF')
""", encoding="utf-8")
    path.chmod(0o755)
    return path


def test_all_documents_complete_drm_ingest_viewer_e2e(tmp_path):
    source_documents = sorted((REPO_ROOT / "data" / "raw").glob("*.xlsx"))
    assert source_documents, "E2E requires checked-in XLSX documents"

    workspace_root = tmp_path / "workspace"
    raw = workspace_root / "data" / "raw"
    authorized_outbox = workspace_root / "authorized-unlock-outbox"
    staging = workspace_root / "data" / "unlocked-staging"
    for directory in (raw, authorized_outbox, staging):
        directory.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REPO_ROOT / "config", workspace_root / "config")

    # Every repository document first enters the test workspace as protected.
    original_hashes = {}
    for source in source_documents:
        authorized = authorized_outbox / source.name
        shutil.copyfile(source, authorized)
        original_hashes[source.name] = sha256_file(authorized)
        protected = raw / source.name
        _protect_copy(protected)
        assert sniff_container(protected) == {
            "container": "ole_cfb", "locked": True,
            "detail": "OLE/CFB — 암호화된 Office 문서 또는 DRM 래퍼",
        }

    store = KgStore(workspace_root / "data" / "kg" / "kg.db")
    workspace = Workspace(workspace_root, store=store)

    # Locked documents are rejected and only an official request is recorded.
    for source in source_documents:
        rejected = ingest_file(store, workspace_root, raw / source.name,
                               workspace.parser_rules, workspace.units,
                               workspace.registry)
        assert rejected["locked"] is True and "DRM 해제 요청 필요" in rejected["error"]
        request = create_request(store, raw, source.name, "repository DRM E2E")
        assert request["request_id"].startswith("DRM-")
    assert {row["status"] for row in store.conn.execute("SELECT status FROM drm_request")} == \
        {"REQUESTED"}

    # Model the authorized service delivering readable XLSX results. The app
    # itself performs no unlock/decryption and only validates the delivered file.
    for source in source_documents:
        shutil.copyfile(authorized_outbox / source.name, raw / source.name)
    assert refresh_release_states(store, raw) == len(source_documents)

    renderer = _fake_soffice(tmp_path / "fake-soffice")
    completed = []
    for source in source_documents:
        result = ingest_file(store, workspace_root, raw / source.name,
                             workspace.parser_rules, workspace.units,
                             workspace.registry)
        assert not result.get("locked") and result["document_id"]
        document_id = result["document_id"]
        assert store.active_nodes(document_id), f"{source.name} produced no Document KG nodes"
        version = store.latest_version(document_id)
        assert version is not None
        mark_ingested(store, source.name)

        # The authorized output is independently registered as the immutable
        # Viewer source and rendered only into a disposable hash cache.
        staged = staging / source.name
        shutil.copyfile(authorized_outbox / source.name, staged)
        metadata = register_unlocked(store, document_id, version["version_id"],
                                     staged, staging,
                                     workspace_root / "data" / "unlocked")
        assert metadata["drm_status"] == "READY"
        assert metadata["sha256"] == original_hashes[source.name]
        preview = render_preview(store, document_id, version["version_id"],
                                 workspace_root / "data" / "viewer-cache",
                                 str(renderer))
        assert preview.is_file()
        first_sheet = sheets(store, document_id, version["version_id"])[0]
        locator = source_locator(store, document_id, version["version_id"],
                                 first_sheet["sheet_name"], "A1", None)
        assert locator["document_version"] == version["version_id"]
        assert locator["a1_range"] == "A1:A1"
        assert "path" not in locator
        completed.append(document_id)

    store.commit()
    assert len(set(completed)) == len(source_documents)
    assert {row["status"] for row in store.conn.execute("SELECT status FROM drm_request")} == \
        {"INGESTED"}
    assert {row["drm_status"] for row in store.conn.execute(
        "SELECT drm_status FROM viewer_document_version")} == {"READY"}
    assert {row["render_status"] for row in store.conn.execute(
        "SELECT render_status FROM viewer_document_version")} == {"SUCCESS"}

    # Registration and rendering never alter either authorized output or raw
    # release copy; all hashes still match the checked-in source documents.
    for source in source_documents:
        assert sha256_file(authorized_outbox / source.name) == original_hashes[source.name]
        assert sha256_file(raw / source.name) == original_hashes[source.name]
    store.close()
