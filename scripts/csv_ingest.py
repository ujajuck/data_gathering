#!/usr/bin/env python
"""CSV → tree_node 인제스트 — _source_file 기반 DOCUMENT 그룹핑

각 CSV의 _source_file(원본 파일명)을 DOCUMENT 단위로 사용.
같은 _source_file 값을 가진 행이 여러 CSV에 걸쳐 있으면 같은 DOCUMENT 아래에 모임.
SHEET = CSV 소스명, SECTION = L1 카테고리, HEADER/VALUE = 컬럼/셀값.

Usage:
    python scripts/csv_ingest.py --ws domains/mlcc_additive
"""
from __future__ import annotations
import argparse, csv, hashlib, json, sys
from io import StringIO
from pathlib import Path
from collections import defaultdict

import urllib.request

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from kg.store import KgStore

CSV_BASE = "http://166.79.21.126:8600/raw"
CSV_FILES = {
    "checksheet_table": {"url": f"{CSV_BASE}/checksheet_table.csv", "file_col": "파일명"},
    "data_table":       {"url": f"{CSV_BASE}/data_table.csv",       "file_col": "_source_file"},
    "dc_db_table":      {"url": f"{CSV_BASE}/dc_db_table.csv",      "file_col": "_source_file"},
    "dc_table":         {"url": f"{CSV_BASE}/dc_table.csv",         "file_col": "_source_file"},
    "joined_data_dc":   {"url": f"{CSV_BASE}/joined_data_dc.csv",   "file_col": "_source_file"},
}

from scripts.csv_dkg_builder import HEADER_CATEGORIES, HEADER_TO_CONCEPT, UNIFIED_L1


def nid(*parts: str) -> str:
    return hashlib.sha256("/".join(str(p) for p in parts if p).encode()).hexdigest()[:16]


def fetch_csv(url: str) -> list[dict]:
    data = urllib.request.urlopen(url).read()
    return list(csv.DictReader(StringIO(data.decode("utf-8-sig"))))


def normalize_source(raw: str) -> str:
    """_source_file 원본값을 정규화: (평가결과) 접두사 제거, .xlsx 제거, 공백 정리."""
    s = raw.strip()
    # "(평가결과) ..." 또는 "(평가결과)..." 제거
    if s.startswith("(평가결과)"):
        s = s[len("(평가결과)"):].strip()
    # ".xlsx" 제거 (있으면)
    if s.lower().endswith(".xlsx"):
        s = s[:-5]
    return s.strip()


def ingest_all(store: KgStore) -> dict:
    """모든 CSV를 읽어 _source_file 기준으로 DOCUMENT 그룹핑 후 인제스트."""
    store.conn.execute("PRAGMA foreign_keys = OFF")

    # 1) 모든 CSV 데이터 로드 + _source_file별 그룹핑
    #    source_file → { csv_name → [rows] }
    source_groups: dict[str, dict[str, list[dict]]] = defaultdict(lambda: defaultdict(list))

    for csv_name, csv_info in CSV_FILES.items():
        rows = fetch_csv(csv_info["url"])
        file_col = csv_info["file_col"]
        for row in rows:
            raw_sf = row.get(file_col, "") or ""
            if raw_sf:
                norm = normalize_source(raw_sf)
                source_groups[norm][csv_name].append(row)
            else:
                # _source_file이 없는 행은 "unknown" 그룹
                source_groups[f"__{csv_name}_no_source__"][csv_name].append(row)
        print(f"  📥 {csv_name}: {len(rows)} rows loaded")

    print(f"\n📂 _source_file 그룹: {len(source_groups)}개")

    # 2) 기존 CHECKSHEET 문서와 매칭
    existing_docs = {}
    for r in store.conn.execute(
            "SELECT document_id, filename FROM document WHERE filepath LIKE 'F:%'").fetchall():
        # 파일명에서 CHECKSHEET_ 접두사 제거, .xlsx 제거
        fname = r["filename"]
        if fname.lower().endswith(".xlsx"):
            fname = fname[:-5]
        existing_docs[fname] = r["document_id"]

    matched = 0
    unmatched_sources = []

    # 3) _source_file별 DOCUMENT 생성
    total_nodes = 0
    total_docs = 0

    for source_file, csv_data in sorted(source_groups.items()):
        if source_file.startswith("__"):
            # _source_file 없는 행 — CSV 이름으로 DOCUMENT
            doc_name = source_file.replace("__", "").replace("_no_source__", "")
            doc_id = nid("csv", doc_name)
        else:
            doc_name = source_file
            doc_id = nid("src", source_file)

        # 기존 문서와 매칭 시도
        existing_doc_id = None
        for ef_name, ef_id in existing_docs.items():
            # 부분 매칭: source_file이 기존 파일명에 포함되거나 반대
            if source_file in ef_name or ef_name in source_file:
                existing_doc_id = ef_id
                matched += 1
                break

        if existing_doc_id:
            # 기존 문서에 CSV 데이터 추가
            doc_id = existing_doc_id
        else:
            if not source_file.startswith("__"):
                unmatched_sources.append(source_file)
            # 새 DOCUMENT 노드 생성
            existing = store.conn.execute(
                "SELECT node_id FROM tree_node WHERE node_id=? AND node_type='DOCUMENT'",
                (doc_id,)).fetchone()
            if not existing:
                store.conn.execute(
                    "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                    "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (doc_id, doc_id, "DOCUMENT", doc_name, doc_name,
                     "ACTIVE", "", "", None,
                     json.dumps({"source": "csv", "_source_file": source_file}, ensure_ascii=False)))
                total_nodes += 1

                # document 테이블에도 등록
                existing_doc = store.conn.execute(
                    "SELECT 1 FROM document WHERE document_id=?", (doc_id,)).fetchone()
                if not existing_doc:
                    store.conn.execute(
                        "INSERT INTO document (document_id, filename, filepath, file_type) "
                        "VALUES (?,?,?,?)",
                        (doc_id, doc_name, f"csv://{source_file}", "csv"))
                total_docs += 1

        # 4) CSV별 SHEET + SECTION + HEADER + VALUE
        for csv_name, rows in csv_data.items():
            categories = HEADER_CATEGORIES.get(csv_name, {})

            # SHEET
            sheet_id = nid("src", source_file, csv_name)
            existing_sheet = store.conn.execute(
                "SELECT node_id FROM tree_node WHERE node_id=?", (sheet_id,)).fetchone()
            if not existing_sheet:
                store.conn.execute(
                    "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                    "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (sheet_id, doc_id, "SHEET", csv_name,
                     f"{doc_name}/{csv_name}",
                     "ACTIVE", "", "", doc_id,
                     json.dumps({"source": "csv", "csv_name": csv_name}, ensure_ascii=False)))
                total_nodes += 1

            for row_idx, row in enumerate(rows):
                for cat_id, cat_info in categories.items():
                    cat_name = cat_info["name"]
                    section_id = nid("src", source_file, csv_name, cat_id, str(row_idx))
                    store.conn.execute(
                        "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                        "status,semantic_fingerprint,content_fingerprint,parent_node_id,metadata) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (section_id, doc_id, "SECTION", cat_name,
                         f"{doc_name}/{csv_name}/{cat_name}/row{row_idx}",
                         "ACTIVE", "", "", sheet_id,
                         json.dumps({"l1_concept": cat_id, "row_idx": row_idx,
                                     "_source_file": source_file}, ensure_ascii=False)))
                    total_nodes += 1

                    for header in cat_info["headers"]:
                        value = str(row.get(header, "") or "").strip()
                        concept_hint = HEADER_TO_CONCEPT.get(header, header)

                        header_id = nid("src", source_file, csv_name, cat_id, str(row_idx), header, "H")
                        store.conn.execute(
                            "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                            "status,semantic_fingerprint,content_fingerprint,parent_node_id,"
                            "metadata,representative_values,locator) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                            (header_id, doc_id, "HEADER", header,
                             f"{doc_name}/{csv_name}/{cat_name}/row{row_idx}/{header}",
                             "ACTIVE", "", "", section_id,
                             json.dumps({"concept_hint": concept_hint, "l1_concept": cat_id},
                                        ensure_ascii=False),
                             json.dumps([value], ensure_ascii=False) if value else "[]",
                             f"{csv_name}!{header}"))
                        total_nodes += 1

                        if value:
                            value_id = nid("src", source_file, csv_name, cat_id, str(row_idx), header, "V")
                            store.conn.execute(
                                "INSERT INTO tree_node (node_id,document_id,node_type,node_name,tree_path,"
                                "status,semantic_fingerprint,content_fingerprint,parent_node_id,"
                                "metadata,representative_values) "
                                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                (value_id, doc_id, "VALUE", value[:200],
                                 f"{doc_name}/{csv_name}/{cat_name}/row{row_idx}/{header}/value",
                                 "ACTIVE", "", "", header_id,
                                 json.dumps({"concept_hint": concept_hint}, ensure_ascii=False),
                                 json.dumps([value], ensure_ascii=False)))
                            total_nodes += 1

        store.conn.commit()

    print(f"\n📊 인제스트 결과:")
    print(f"  _source_file 그룹: {len(source_groups)}개")
    print(f"  기존 문서 매칭: {matched}개")
    print(f"  신규 DOCUMENT: {total_docs}개")
    print(f"  총 노드: {total_nodes:,}개")

    if unmatched_sources:
        print(f"\n⚠️ 매칭 안 된 _source_file ({len(unmatched_sources)}개):")
        for s in unmatched_sources[:10]:
            print(f"    {s}")
        if len(unmatched_sources) > 10:
            print(f"    ... ({len(unmatched_sources)-10}개 더)")

    return {"source_groups": len(source_groups), "matched": matched,
            "new_docs": total_docs, "total_nodes": total_nodes}


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
    parser = argparse.ArgumentParser(description="CSV → tree_node 인제스트 (_source_file 기반)")
    parser.add_argument("--ws", type=Path, default=Path("domains/mlcc_additive"))
    args = parser.parse_args()

    db_path = args.ws / "data" / "kg" / "kg.db"
    store = KgStore(db_path)

    print(f"📦 CSV 인제스트 시작: {db_path}")

    result = ingest_all(store)
    auto_map(store)

    total_nodes = store.conn.execute(
        "SELECT COUNT(*) FROM tree_node WHERE status='ACTIVE'").fetchone()[0]
    doc_count = store.conn.execute(
        "SELECT COUNT(*) FROM tree_node WHERE node_type='DOCUMENT' AND status='ACTIVE'").fetchone()[0]
    print(f"\n📊 최종: {doc_count} 문서, {total_nodes:,} 활성 노드")


if __name__ == "__main__":
    main()
