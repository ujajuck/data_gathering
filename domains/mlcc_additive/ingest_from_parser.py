"""checksheet_parsed.json → kg DB 적재

checksheet_parser.py의 구조화된 출력을 트리 노드로 변환하여
기존 generic grid 파싱 결과를 대체한다.
"""
import sys, os, json, time
sys.path.insert(0, r"F:\llm\data_gathering")
os.chdir(r"F:\llm\data_gathering")

from pathlib import Path
from kg.store import KgStore, stable_id, new_id, now_iso
from src.common.hashing import sha256_file
from src.inspect.inspector import PARSER_VERSION

WS_ROOT = Path("domains/mlcc_additive")
DB_PATH = WS_ROOT / "data" / "kg" / "kg.db"
DATA_DIR = Path(r'F:\재료데이터\data\MLCC조성Lab_유전체 개발_전장 재료_X7R_WS 평가_31B106KB_첨가제')
PARSED_JSON = Path(r'F:\재료데이터\석주연분석자료\checksheet_parsed.json')

# ── 섹션명 → DKG L1 concept_id 매핑 ──
SECTION_TO_L1 = {
    "실험기본정보": "domain_experiment",
    "실험요약": "domain_summary",
    "칭량공정": "domain_weighing",
    "APEX공정": "domain_apex",
    "APEX공정 (해쇄필터)": "domain_apex_filter",
    "MFD 공정": "domain_apex_filter",
    "최종필터 공정": "domain_final_filter",
    "배치 검사 (최종필터 후)": "domain_batch_inspection",
    "교반 Table": "domain_stirring",
}

# ── 필드명 → DKG concept_id 매핑 ──
FIELD_TO_CONCEPT = {
    "제목": "title", "자료코드": "material_code", "투입일": "input_date",
    "작성자": "author",
    "LOT": "lot_no", "Powder": "powder", "Binder조성": "binder_composition",
    "Additive": "additive", "S/R비": "sr_ratio", "Binder": "binder",
    "분산제": "dispersant", "고형분": "solid_content_pct", "솔벤트": "solvent",
    "투입제품": "input_product", "무게Target(g)": "weight_target",
    "공차": "tolerance", "조합내역": "combination_detail", "LOT_No.": "input_lot_no",
    "자재 명": "material_name", "투입량": "input_amount",
    "체크항목": "check_item", "Target": "target_value",
    "구분": "inspection_category", "검사결과_단위": "inspection_unit",
    "세부공정": "sub_process", "Tank_TYPE": "tank_type",
    "비고": "memo",
    "항목": "calc_item", "투입 무게 [g]": "weight_g",
    "파우더": "solute_powder", "분산제": "solute_dispersant",
    "바인더": "solute_binder", "가소제": "solute_plasticizer",
    "Etoh": "solvent_etoh", "Toluene": "solvent_toluene",
    "Sol 양": "sol_amount",
}


def _parse_value(val):
    """값을 (display_str, numeric_val, data_type)으로 분류"""
    if val is None:
        return None, None, "text"
    if isinstance(val, (int, float)):
        return str(val), val, "numeric"
    cleaned = str(val).replace(",", "").replace(" ", "").strip()
    try:
        if "." in cleaned:
            n = float(cleaned)
            return str(val), n, "numeric"
        n = int(cleaned)
        return str(val), n, "numeric"
    except (ValueError, OverflowError):
        return str(val), None, "text"


def ingest_parsed(store, parsed, filepath):
    filename = parsed.get("파일명", filepath.name)
    logical = str(filepath)
    doc_id = stable_id(logical)
    file_hash = sha256_file(filepath)

    prev = store.latest_version(doc_id)
    if prev is not None and prev["file_hash"] == file_hash and prev["parser_version"] == PARSER_VERSION:
        return doc_id, "skip"

    # 1) document 먼저 INSERT
    store.conn.execute(
        """INSERT INTO document (document_id, filename, filepath, file_type)
           VALUES (?,?,?,'xlsx')
           ON CONFLICT(document_id) DO UPDATE SET
             filename=excluded.filename, filepath=excluded.filepath""",
        (doc_id, filename, str(filepath)))

    # 2) document_version
    ver_id = new_id("VER")
    store.conn.execute(
        "INSERT INTO document_version (version_id, document_id, file_hash, parser_version, parsed_at) VALUES (?,?,?,?,?)",
        (ver_id, doc_id, file_hash, PARSER_VERSION, now_iso()))

    # 3) 기존 노드 비활성화
    store.conn.execute("UPDATE tree_node SET status='INACTIVE' WHERE document_id=?", (doc_id,))

    # 4) DOCUMENT 노드
    doc_path = f"/{filename}"
    store.conn.execute(
        """INSERT OR IGNORE INTO tree_node
           (node_id, document_id, parent_node_id, node_type, node_name,
            tree_path, semantic_fingerprint, content_fingerprint,
            status, created_version_id)
           VALUES (?,?,NULL,?,?,?,?,?,?,?)""",
        (stable_id(doc_path), doc_id, "DOCUMENT", filename,
         doc_path, "", "", "ACTIVE", ver_id))

    # 5) sheet정보 루프
    for sheet_idx, sheet_data in enumerate(parsed.get("sheet정보", [])):
        for sheet_name, sections in sheet_data.items():
            sheet_path = f"{doc_path}/{sheet_name}"
            store.conn.execute(
                """INSERT OR IGNORE INTO tree_node
                   (node_id, document_id, parent_node_id, node_type, node_name,
                    tree_path, semantic_fingerprint, content_fingerprint,
                    status, created_version_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (stable_id(sheet_path), doc_id, stable_id(doc_path),
                 "SHEET", sheet_name, sheet_path, "", "",
                 "ACTIVE", ver_id))

            if not isinstance(sections, dict):
                continue

            for sec_name, sec_data in sections.items():
                l1_id = SECTION_TO_L1.get(sec_name)
                sec_path = f"{sheet_path}/{sec_name}"
                meta = {"l1_concept": l1_id} if l1_id else None
                store.conn.execute(
                    """INSERT OR IGNORE INTO tree_node
                       (node_id, document_id, parent_node_id, node_type, node_name,
                        tree_path, metadata, semantic_fingerprint, content_fingerprint,
                        status, created_version_id)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    (stable_id(sec_path), doc_id, stable_id(sheet_path),
                     "TABLE", sec_name, sec_path,
                     json.dumps(meta, ensure_ascii=False) if meta else None,
                     "", "",
                     "ACTIVE", ver_id))

                if sec_data is None:
                    continue

                if isinstance(sec_data, dict):
                    # 단순 키-값 섹션
                    for key, val in sec_data.items():
                        concept_id = FIELD_TO_CONCEPT.get(key)
                        field_path = f"{sec_path}/{key}"
                        display, numeric, dtype = _parse_value(val)
                        rep_vals = json.dumps([numeric if numeric is not None else display], ensure_ascii=False)
                        meta = {"concept_hint": concept_id} if concept_id else None
                        store.conn.execute(
                            """INSERT OR IGNORE INTO tree_node
                               (node_id, document_id, parent_node_id, node_type, node_name,
                                tree_path, data_type, representative_values, metadata,
                                semantic_fingerprint, content_fingerprint,
                                status, created_version_id)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (stable_id(field_path), doc_id, stable_id(sec_path),
                             "HEADER", key, field_path, dtype, rep_vals,
                             json.dumps(meta, ensure_ascii=False) if meta else None,
                             "", "",
                             "ACTIVE", ver_id))

                elif isinstance(sec_data, list):
                    # 배열 섹션
                    for row_idx, row in enumerate(sec_data):
                        if isinstance(row, dict):
                            row_path = f"{sec_path}/[{row_idx}]"
                            row_name = str(next(iter(row.values()), f"[{row_idx}]"))[:60]
                            store.conn.execute(
                                """INSERT OR IGNORE INTO tree_node
                                   (node_id, document_id, parent_node_id, node_type, node_name,
                                    tree_path, status, semantic_fingerprint, content_fingerprint,
                                    created_version_id)
                                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                                (stable_id(row_path), doc_id, stable_id(sec_path),
                                 "HEADER", row_name, row_path, "ACTIVE", "", "",
                                 ver_id))

                            for key, val in row.items():
                                concept_id = FIELD_TO_CONCEPT.get(key)
                                field_path = f"{row_path}/{key}"
                                display, numeric, dtype = _parse_value(val)
                                rep_vals = json.dumps([numeric if numeric is not None else display], ensure_ascii=False)
                                meta = {"concept_hint": concept_id} if concept_id else None
                                store.conn.execute(
                                    """INSERT OR IGNORE INTO tree_node
                                       (node_id, document_id, parent_node_id, node_type, node_name,
                                        tree_path, data_type, representative_values, metadata,
                                        semantic_fingerprint, content_fingerprint,
                                        status, created_version_id)
                                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                                    (stable_id(field_path), doc_id, stable_id(row_path),
                                     "VALUE", key, field_path, dtype, rep_vals,
                                     json.dumps(meta, ensure_ascii=False) if meta else None,
                                     "", "",
                                     "ACTIVE", ver_id))

    # document current_version 갱신
    store.conn.execute(
        "UPDATE document SET current_version=? WHERE document_id=?",
        (ver_id, doc_id))

    return doc_id, "ok"


def main():
    store = KgStore(DB_PATH)
    store.conn.execute('PRAGMA foreign_keys = OFF')
    os.environ["_KG_DB_PATH"] = str(DB_PATH.resolve())

    parsed_all = json.loads(PARSED_JSON.read_text(encoding="utf-8"))
    print(f"파싱 결과: {len(parsed_all)}건")

    files = {f.name: f for f in DATA_DIR.iterdir()
             if f.suffix in ('.xlsx', '.xls') and not f.name.startswith('~$')}

    ok = skip = fail = 0
    t0 = time.time()

    for i, parsed in enumerate(parsed_all, 1):
        fn = parsed.get("파일명", "")
        if "에러" in parsed:
            fail += 1
            print(f"  [{i:2d}/{len(parsed_all)}] ERROR {fn[:50]}")
            continue

        fp = files.get(fn)
        if fp is None:
            for name, path in files.items():
                if fn[:20] in name or name[:20] in fn:
                    fp = path
                    break
        if fp is None:
            fail += 1
            print(f"  [{i:2d}/{len(parsed_all)}] SKIP  {fn[:50]}  (파일 없음)")
            continue

        try:
            doc_id, status = ingest_parsed(store, parsed, fp)
            if status == "skip":
                skip += 1
                print(f"  [{i:2d}/{len(parsed_all)}] SKIP  {fn[:55]}")
            else:
                ok += 1
                print(f"  [{i:2d}/{len(parsed_all)}] OK    {fn[:55]}")
        except Exception as e:
            import traceback
            fail += 1
            print(f"  [{i:2d}/{len(parsed_all)}] ERROR {fn[:50]}  {str(e)[:80]}")

    store.commit()
    elapsed = time.time() - t0
    print(f"\n완료: {ok} ok, {skip} skip, {fail} fail, {elapsed:.1f}s")

    total = store.conn.execute("SELECT count(*) FROM tree_node WHERE status='ACTIVE'").fetchone()[0]
    docs = store.conn.execute("SELECT count(*) FROM document").fetchone()[0]
    print(f"DB: {docs} documents, {total} active nodes")


if __name__ == "__main__":
    main()
