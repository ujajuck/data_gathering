"""Versioned, declarative Excel parsing templates and document deltas.

This module deliberately returns extracted values and provenance only.  It does
not create KG nodes and it never lets hooks mutate the database.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils.cell import range_boundaries

from kg.store import KgStore, new_id, now_iso

LIFECYCLES = {"DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"}
ASSIGNMENT_STATES = {"ASSIGNED", "PARSED", "REVIEW_REQUIRED", "OVERRIDDEN", "FAILED"}


class ParsingError(ValueError):
    """A template request is invalid or cannot be resolved."""


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _load(value: str | None, default=None):
    return default if value is None else json.loads(value)


def _validate_spec(spec: dict) -> list[dict]:
    sheets = spec.get("sheet_templates")
    if not isinstance(sheets, list) or not sheets:
        raise ParsingError("sheet_templates must be a non-empty list")
    seen_sheets: set[str] = set()
    for sheet in sheets:
        name = sheet.get("name")
        if not isinstance(name, str) or not name or name in seen_sheets:
            raise ParsingError("sheet template names must be unique non-empty strings")
        seen_sheets.add(name)
        matcher = sheet.get("match", {})
        if not isinstance(matcher, dict) or not any(
                k in matcher for k in ("names", "name_regex", "headers")):
            raise ParsingError(f"sheet template {name} needs a matcher")
        if "name_regex" in matcher:
            try:
                re.compile(matcher["name_regex"])
            except (re.error, TypeError) as exc:
                raise ParsingError(f"invalid name_regex in {name}: {exc}") from exc
        mappings = sheet.get("mappings", [])
        if not isinstance(mappings, list):
            raise ParsingError(f"mappings in {name} must be a list")
        keys: set[str] = set()
        for mapping in mappings:
            key = mapping.get("key")
            if not isinstance(key, str) or not key or key in keys:
                raise ParsingError(f"mapping keys in {name} must be unique")
            keys.add(key)
            source = mapping.get("source")
            if not isinstance(source, dict) or not (
                    source.get("range") or source.get("key_search")):
                raise ParsingError(f"mapping {key} needs source.range or source.key_search")
    return sheets


def create_template(store: KgStore, template_id: str, name: str,
                    target_document_kg: str | None, lifecycle: str = "DRAFT") -> dict:
    if lifecycle not in LIFECYCLES:
        raise ParsingError("invalid template lifecycle")
    store.conn.execute(
        "INSERT INTO parsing_template VALUES (?,?,?,?,?)",
        (template_id, name, target_document_kg, lifecycle, now_iso()))
    return template_detail(store, template_id)


def add_version(store: KgStore, template_id: str, spec: dict,
                created_by: str | None = None) -> dict:
    sheets = _validate_spec(spec)
    template = store.conn.execute(
        "SELECT 1 FROM parsing_template WHERE template_id=?", (template_id,)).fetchone()
    if template is None:
        raise ParsingError("unknown template")
    version = store.conn.execute(
        "SELECT COALESCE(MAX(version),0)+1 FROM parsing_template_version WHERE template_id=?",
        (template_id,)).fetchone()[0]
    store.conn.execute(
        "INSERT INTO parsing_template_version VALUES (?,?,?,?,?)",
        (template_id, version, _dump(spec), now_iso(), created_by))
    for ordinal, sheet in enumerate(sheets):
        sid = new_id("SHT")
        store.conn.execute(
            "INSERT INTO sheet_template VALUES (?,?,?,?,?,?)",
            (sid, template_id, version, sheet["name"], _dump(sheet["match"]), ordinal))
        for mapping in sheet.get("mappings", []):
            store.conn.execute(
                "INSERT INTO template_mapping VALUES (?,?,?,?,?,?,?,?,?)",
                (new_id("TMAP"), sid, mapping["key"], mapping.get("concept_id"),
                 mapping.get("document_kg_node"), _dump(mapping["source"]),
                 mapping.get("type"), mapping.get("unit"),
                 _dump(mapping.get("normalization", {}))))
    return version_detail(store, template_id, version)


def template_detail(store: KgStore, template_id: str) -> dict:
    row = store.conn.execute(
        "SELECT * FROM parsing_template WHERE template_id=?", (template_id,)).fetchone()
    if row is None:
        raise ParsingError("unknown template")
    out = dict(row)
    out["versions"] = [r[0] for r in store.conn.execute(
        "SELECT version FROM parsing_template_version WHERE template_id=? ORDER BY version",
        (template_id,))]
    out["current_version"] = out["versions"][-1] if out["versions"] else None
    return out


def version_detail(store: KgStore, template_id: str, version: int) -> dict:
    row = store.conn.execute(
        "SELECT * FROM parsing_template_version WHERE template_id=? AND version=?",
        (template_id, version)).fetchone()
    if row is None:
        raise ParsingError("unknown template version")
    out = dict(row)
    out["spec"] = _load(out.pop("spec_json"))
    out["sheet_templates"] = []
    sheets = store.conn.execute(
        "SELECT * FROM sheet_template WHERE template_id=? AND template_version=? ORDER BY ordinal",
        (template_id, version)).fetchall()
    for sheet in sheets:
        item = dict(sheet)
        item["match"] = _load(item.pop("matcher_json"))
        item["mappings"] = []
        for mapping in store.conn.execute(
                "SELECT * FROM template_mapping WHERE sheet_template_id=? ORDER BY mapping_key",
                (sheet["sheet_template_id"],)):
            m = dict(mapping)
            m["source"] = _load(m.pop("source_json"))
            m["normalization"] = _load(m.pop("normalization_json"), {})
            item["mappings"].append(m)
        out["sheet_templates"].append(item)
    return out


def assign(store: KgStore, document_id: str, document_version: str,
           template_id: str, template_version: int) -> dict:
    docver = store.conn.execute(
        "SELECT document_id FROM document_version WHERE version_id=?", (document_version,)).fetchone()
    if docver is None or docver["document_id"] != document_id:
        raise ParsingError("document version does not belong to document")
    version_detail(store, template_id, template_version)
    store.conn.execute(
        """INSERT INTO document_template_assignment VALUES (?,?,?,?,?,?)
           ON CONFLICT(document_id,document_version) DO UPDATE SET
             template_id=excluded.template_id, template_version=excluded.template_version,
             status='ASSIGNED', assigned_at=excluded.assigned_at""",
        (document_id, document_version, template_id, template_version, "ASSIGNED", now_iso()))
    return dict(store.conn.execute(
        "SELECT * FROM document_template_assignment WHERE document_version=?",
        (document_version,)).fetchone())


def save_override(store: KgStore, document_id: str, document_version: str,
                  template_mapping_id: str, source: dict, reason: str | None,
                  created_by: str | None, status: str = "APPROVED") -> dict:
    assignment = store.conn.execute(
        "SELECT * FROM document_template_assignment WHERE document_id=? AND document_version=?",
        (document_id, document_version)).fetchone()
    mapping = store.conn.execute(
        """SELECT tm.* FROM template_mapping tm JOIN sheet_template st
             ON st.sheet_template_id=tm.sheet_template_id
           WHERE tm.mapping_id=? AND st.template_id=? AND st.template_version=?""",
        (template_mapping_id, assignment["template_id"] if assignment else "",
         assignment["template_version"] if assignment else -1)).fetchone()
    if assignment is None or mapping is None:
        raise ParsingError("override mapping is not part of the assigned template version")
    if not isinstance(source, dict) or not source.get("range"):
        raise ParsingError("override_source.range is required")
    existing = store.conn.execute(
        "SELECT override_id,created_at FROM document_override WHERE document_version=? AND template_mapping_id=?",
        (document_version, template_mapping_id)).fetchone()
    oid = existing["override_id"] if existing else new_id("OVR")
    created = existing["created_at"] if existing else now_iso()
    store.conn.execute(
        """INSERT INTO document_override VALUES (?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(document_version,template_mapping_id) DO UPDATE SET
             override_source_json=excluded.override_source_json,status=excluded.status,
             reason=excluded.reason,created_by=excluded.created_by,updated_at=excluded.updated_at""",
        (oid, document_id, document_version, template_mapping_id, _dump(source), status,
         reason, created_by, created, now_iso()))
    store.conn.execute(
        "UPDATE document_template_assignment SET status='OVERRIDDEN' WHERE document_version=?",
        (document_version,))
    return override_detail(store, oid)


def override_detail(store: KgStore, override_id: str) -> dict:
    row = store.conn.execute(
        "SELECT * FROM document_override WHERE override_id=?", (override_id,)).fetchone()
    if row is None:
        raise ParsingError("unknown override")
    out = dict(row)
    out["override_source"] = _load(out.pop("override_source_json"))
    return out


def effective_mappings(store: KgStore, document_version: str) -> list[dict]:
    assignment = store.conn.execute(
        "SELECT * FROM document_template_assignment WHERE document_version=?", (document_version,)).fetchone()
    if assignment is None:
        raise ParsingError("document version has no template assignment")
    rows = store.conn.execute(
        """SELECT tm.*,st.name sheet_template,st.matcher_json,o.override_id,
                  o.override_source_json,o.status override_status,o.reason override_reason
             FROM sheet_template st JOIN template_mapping tm
               ON tm.sheet_template_id=st.sheet_template_id
             LEFT JOIN document_override o ON o.template_mapping_id=tm.mapping_id
               AND o.document_version=? AND o.status='APPROVED'
            WHERE st.template_id=? AND st.template_version=?
            ORDER BY st.ordinal,tm.mapping_key""",
        (document_version, assignment["template_id"], assignment["template_version"])).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["matcher"] = _load(item.pop("matcher_json"))
        item["template_source"] = _load(item.pop("source_json"))
        override = _load(item.pop("override_source_json"), None)
        item["effective_source"] = override or item["template_source"]
        item["mapping_source"] = "MANUAL" if override else "TEMPLATE"
        item.pop("normalization_json", None)
        result.append(item)
    return result


def _route_sheet(workbook, matcher: dict) -> list:
    names = set(matcher.get("names", []))
    regex = matcher.get("name_regex")
    headers = {str(v).strip() for v in matcher.get("headers", [])}
    matched = []
    for sheet in workbook.worksheets:
        name_ok = sheet.title in names or (regex and re.search(regex, sheet.title))
        header_ok = False
        if headers:
            observed = {str(cell.value).strip() for row in sheet.iter_rows(
                min_row=1, max_row=min(sheet.max_row, 30),
                min_col=1, max_col=min(sheet.max_column, 30)) for cell in row
                if cell.value is not None}
            header_ok = bool(headers & observed)
        if name_ok or header_ok:
            matched.append(sheet)
    return matched


def _locate_key(sheet, source: dict) -> str | None:
    terms = {str(v).strip() for v in source.get("key_search", [])}
    offset = source.get("offset", {})
    for row in sheet.iter_rows():
        for cell in row:
            if cell.value is not None and str(cell.value).strip() in terms:
                target = sheet.cell(cell.row + int(offset.get("row", 0)),
                                    cell.column + int(offset.get("col", 1)))
                return target.coordinate
    return None


def _read_range(sheet, address: str):
    min_col, min_row, max_col, max_row = range_boundaries(address)
    values = [[sheet.cell(row, col).value for col in range(min_col, max_col + 1)]
              for row in range(min_row, max_row + 1)]
    return values[0][0] if len(values) == 1 and len(values[0]) == 1 else values


def run_parse(store: KgStore, document_id: str, document_version: str,
              path: Path) -> dict:
    assignment = store.conn.execute(
        "SELECT * FROM document_template_assignment WHERE document_id=? AND document_version=?",
        (document_id, document_version)).fetchone()
    if assignment is None:
        raise ParsingError("document version has no template assignment")
    run_id, started = new_id("RUN"), now_iso()
    store.conn.execute(
        "INSERT INTO parse_run VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, document_id, document_version, assignment["template_id"],
         assignment["template_version"], started, None, "RUNNING", 0, 0, 0))
    workbook = load_workbook(path, data_only=True)
    mappings = effective_mappings(store, document_version)
    warnings = overrides = successes = 0
    for mapping in mappings:
        matched = _route_sheet(workbook, mapping["matcher"])
        if len(matched) != 1:
            source_range, sheet_name, value = None, None, None
            status = "MISSING" if not matched else "REVIEW_REQUIRED"
            warning = f"sheet matcher returned {len(matched)} sheets"
            warnings += 1
        else:
            sheet = matched[0]
            effective = mapping["effective_source"]
            source_range = effective.get("range") or _locate_key(sheet, effective)
            sheet_name = effective.get("sheet") or sheet.title
            if effective.get("sheet") and effective["sheet"] in workbook.sheetnames:
                sheet = workbook[effective["sheet"]]
            try:
                if not source_range:
                    raise ValueError("source was not found")
                value = _read_range(sheet, source_range)
                status = mapping["mapping_source"]
                warning = None
                successes += 1
                overrides += mapping["mapping_source"] == "MANUAL"
            except (ValueError, IndexError) as exc:
                value, status, warning = None, "MISSING", str(exc)
                warnings += 1
        store.conn.execute(
            "INSERT INTO parsed_source VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (new_id("SRC"), run_id, mapping["mapping_id"], mapping["concept_id"],
             sheet_name, source_range, mapping["mapping_source"],
             _dump(mapping["template_source"]), _dump(mapping["effective_source"]),
             _dump(value), status, warning))
    final = "SUCCESS" if warnings == 0 else ("REVIEW_REQUIRED" if successes else "FAILED")
    assignment_status = "OVERRIDDEN" if overrides and final == "SUCCESS" else final.replace("SUCCESS", "PARSED")
    store.conn.execute(
        """UPDATE parse_run SET finished_at=?,status=?,mapping_count=?,override_count=?,warning_count=?
           WHERE parse_run_id=?""",
        (now_iso(), final, len(mappings), overrides, warnings, run_id))
    store.conn.execute(
        "UPDATE document_template_assignment SET status=? WHERE document_version=?",
        (assignment_status, document_version))
    return parse_result(store, run_id)


def parse_result(store: KgStore, run_id: str) -> dict:
    run = store.conn.execute("SELECT * FROM parse_run WHERE parse_run_id=?", (run_id,)).fetchone()
    if run is None:
        raise ParsingError("unknown parse run")
    result = dict(run)
    result["sources"] = []
    for row in store.conn.execute(
            "SELECT * FROM parsed_source WHERE parse_run_id=? ORDER BY parsed_source_id", (run_id,)):
        source = dict(row)
        for key in ("template_source_json", "effective_source_json", "value_json"):
            source[key.removesuffix("_json")] = _load(source.pop(key))
        result["sources"].append(source)
    return result


def grouped_documents(store: KgStore, target_document_kg: str) -> list[dict]:
    rows = store.conn.execute(
        """SELECT t.template_id,t.name,a.template_version,d.document_id,d.filename,a.status,
                  (SELECT count(*) FROM document_override o
                    WHERE o.document_version=a.document_version AND o.status='APPROVED') overrides
             FROM parsing_template t
             JOIN document_template_assignment a ON a.template_id=t.template_id
             JOIN document d ON d.document_id=a.document_id
            WHERE t.target_document_kg=? ORDER BY t.name,a.template_version,d.filename""",
        (target_document_kg,)).fetchall()
    groups: dict[tuple, dict] = {}
    for row in rows:
        key = (row["template_id"], row["template_version"])
        group = groups.setdefault(key, {"template_id": key[0], "template_name": row["name"],
                                        "version": key[1], "documents": [],
                                        "override_documents": 0, "review_required": 0,
                                        "failed": 0})
        group["documents"].append({"document_id": row["document_id"],
                                   "filename": row["filename"], "status": row["status"],
                                   "override_count": row["overrides"]})
        group["override_documents"] += row["overrides"] > 0
        group["review_required"] += row["status"] == "REVIEW_REQUIRED"
        group["failed"] += row["status"] == "FAILED"
    return list(groups.values())
