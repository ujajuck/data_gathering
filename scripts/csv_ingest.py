#!/usr/bin/env python
"""CSV → tree_node 인제스트 — csv_dkg_builder 템플릿 기반

각 CSV의 행을 tree_node로 변환하여 kg.db에 적재.
DOCUMENT = CSV 파일, SHEET = CSV 이름, SECTION = L1 카테고리,
HEADER = 컬럼명, VALUE = 셀 값

Usage:
    python scripts/csv_ingest.py --ws domains/mlcc_additive
"""
from __future__ import annotations
import argparse, csv, hashlib, json, sys
from io import StringIO
from pathlib import Path

import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from kg.store import KgStore

CSV_BASE = "http://166.79.21.126:8600/raw"
CSV_FILES = {
    "checksheet_table": {"url": f"{CSV_BASE}/checksheet_table.csv", "file_col": "파일명"},
    "data_table": {"url": f"{CSV_BASE}/data_table.csv", "file_col": "_source_file"},
    "dc_db_table": {"url": f"{CSV_BASE}/dc_db_table.csv", "file_col": "_source_file"},
    "dc_table": {"url": f"{CSV_BASE}/dc_table.csv", "file_col": "_source_file"},
    "joined_data_dc": {"url": f"{CSV_BASE}/joined_data_dc.csv", "file_col": "_source_file"},
}

from scripts.csv_dkg_builder import HEADER_CATEGORIES, HEADER_TO_CONCEPT, UNIFIED_L1


def nid(*parts: str) -> str:
    return hashlib.sha256("/".join(str(p) for p in parts if p).encode()).hexdigest()[:16]


def fetch_csv(url: str) -> list[dict]:
    data = urllib.request.urlopen(url).read()
    return list(csv.DictReader(StringIO(data.decode("utf-8-sig"))))


def ingest_csv(store: KgStore, csv_name: str, csv_info: dict) -> dict:
    rows = fetch_csv(csv_info["url"])
    categories = HEADER_CATEGORIES.get(csv_name, {})

    doc_id = nid("csv", csv_name)

    existing = store.conn.execute(
        "SELECT node_id FROM tree_node WHERE node_id=? AND node_type='DOCUMENT'",
        (doc_id,)).fetchone()
    if existing:
        print(f"  ⏭️  {csv_name}: already ingested")
        return {"csv_name": csv_name, "status": "skipped"}

    n = 0

    # DOCUMENT
    store.conn.execute(
        "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
        "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (doc_id, doc_id, "DOCUMENT", csv_name, csv_name,
         "ACTIVE", "", "", None, json.dumps({"source": "csv", "csv_name": csv_name})))
    n += 1

    # SHEET
    sheet_id = nid("csv", csv_name, "sheet")
    store.conn.execute(
        "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
        "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (sheet_id, doc_id, "SHEET", csv_name, f"{csv_name}/{csv_name}",
         "ACTIVE", "", "", doc_id, json.dumps({"source": "csv"})))
    n += 1

    for row_idx, row in enumerate(rows):
        for cat_id, cat_info in categories.items():
            cat_name = cat_info["name"]
            section_id = nid("csv", csv_name, cat_id, str(row_idx))
            store.conn.execute(
                "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (section_id, doc_id, "SECTION", cat_name,
                 f"{csv_name}/{csv_name}/{cat_name}/row{row_idx}",
                 "ACTIVE", "", "", sheet_id,
                 json.dumps({"l1_concept": cat_id, "row_idx": row_idx})))
            n += 1

            for header in cat_info["headers"]:
                value = str(row.get(header, "") or "").strip()
                concept_hint = HEADER_TO_CONCEPT.get(header, header)

                header_id = nid("csv", csv_name, cat_id, str(row_idx), header, "H")
                store.conn.execute(
                    "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                    "status,semantic_fingerprint,content_fingerprint,parent_node_id,"
                    "metadata,representative_values,locator) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                    (header_id, doc_id, "HEADER", header,
                     f"{csv_name}/{csv_name}/{cat_name}/row{row_idx}/{header}",
                     "ACTIVE", "", "", section_id,
                     json.dumps({"concept_hint": concept_hint, "l1_concept": cat_id}),
                     json.dumps([value], ensure_ascii=False) if value else "[]",
                     f"{csv_name}!{header}"))
                n += 1

                if value:
                    value_id = nid("csv", csv_name, cat_id, str(row_idx), header, "V")
                    store.conn.execute(
                        "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                        "status,semantic_fingerprint,content_fingerprint,parent_node_id,"
                        "metadata,representative_values) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                        (value_id, doc_id, "VALUE", value[:200],
                         f"{csv_name}/{csv_name}/{cat_name}/row{row_idx}/{header}/value",
                         "ACTIVE", "", "", header_id,
                         json.dumps({"concept_hint": concept_hint}),
                         json.dumps([value], ensure_ascii=False)))
                    n += 1

    store.conn.commit()
    print(f"  ✅ {csv_name}: {len(rows)} rows → {n} nodes")
    return {"csv_name": csv_name, "status": "ok", "rows": len(rows), "nodes": n}


def auto_map(store: KgStore):
    """metadata.concept_hint → semantic_mapping 자동 매핑."""
    print("\n🔗 concept_hint 자동 매핑...")
    mapped = 0
    rows = store.conn.execute("""
        SELECT tn.node_id, json_extract(tn.metadata, '$.concept_hint') AS concept_hint
        FROM tree_node tn
        WHERE json_extract(tn.metadata, '$.concept_hint') IS NOT NULL
          AND json_extract(tn.metadata, '$.concept_hint') != ''
          AND tn.status = 'ACTIVE' AND tn.node_type IN ('HEADER', 'VALUE')
          AND NOT EXISTS (
            SELECT 1 FROM semantic_mapping sm WHERE sm.tree_node_id = tn.node_id AND sm.status = 'ACTIVE')
    """).fetchall()

    for row in rows:
        concept_id = row["concept_hint"]
        exists = store.conn.execute(
            "SELECT 1 FROM domain_concept WHERE concept_id=?", (concept_id,)).fetchone()
        if exists:
            try:
                store.conn.execute("""
                    INSERT OR IGNORE INTO semantic_mapping
                    (mapping_id, tree_node_id, concept_id, confidence, status, method, is_active, created_at)
                    VALUES (?,?,?,?,'AUTO_APPROVED','concept_hint',1,datetime('now'))""",
                    (nid('map', row['node_id'], concept_id), row["node_id"], concept_id, 1.0))
                mapped += 1
            except Exception:
                pass

    store.conn.commit()
    print(f"  → {mapped} AUTO_APPROVED 매핑 추가")

    auto = store.conn.execute(
        "SELECT COUNT(*) FROM semantic_mapping WHERE status='AUTO_APPROVED'").fetchone()[0]
    total_hv = store.conn.execute(
        "SELECT COUNT(*) FROM tree_node WHERE node_type IN ('HEADER','VALUE') AND status='ACTIVE'").fetchone()[0]
    unmapped = store.conn.execute("""
        SELECT COUNT(*) FROM tree_node tn
        WHERE tn.node_type IN ('HEADER','VALUE') AND tn.status='ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM semantic_mapping sm WHERE sm.tree_node_id=tn.node_id AND sm.status='ACTIVE')
    """).fetchone()[0]
    if total_hv > 0:
        print(f"📈 매핑: {auto} AUTO ({auto*100//total_hv}%), {unmapped} UNMAPPED / {total_hv} total")


def main():
    parser = argparse.ArgumentParser(description="CSV → tree_node 인제스트")
    parser.add_argument("--ws", type=Path, default=Path("domains/mlcc_additive"))
    args = parser.parse_args()

    db_path = args.ws / "data" / "kg" / "kg.db"
    store = KgStore(db_path)

    print(f"📦 CSV 인제스트 시작: {db_path}")
    store.conn.execute("PRAGMA foreign_keys = OFF")

    for csv_name, csv_info in CSV_FILES.items():
        try:
            ingest_csv(store, csv_name, csv_info)
        except Exception as e:
            print(f"  ❌ {csv_name}: {e}")
            import traceback; traceback.print_exc()

    total_nodes = store.conn.execute(
        "SELECT COUNT(*) FROM tree_node WHERE status='ACTIVE'").fetchone()[0]
    doc_count = store.conn.execute(
        "SELECT COUNT(*) FROM tree_node WHERE node_type='DOCUMENT' AND status='ACTIVE'").fetchone()[0]
    print(f"\n📊 총 {doc_count} 문서, {total_nodes} 활성 노드")

    auto_map(store)


if __name__ == "__main__":
    main()
