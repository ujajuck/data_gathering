"""COM으로 각 노드의 셀 주소를 찾아 locator 업데이트."""
import sys, os, json, time
sys.path.insert(0, r"F:\llm\data_gathering")
os.chdir(r"F:\llm\data_gathering")

from pathlib import Path
from kg.store import KgStore, stable_id

DB_PATH = Path("domains/mlcc_additive/data/kg/kg.db")
DATA_DIR = Path(r'F:\재료데이터\data\MLCC조성Lab_유전체 개발_전장 재료_X7R_WS 평가_31B106KB_첨가제')

def main():
    import win32com.client
    import pythoncom
    from openpyxl.utils import get_column_letter

    store = KgStore(DB_PATH)

    try:
        pythoncom.CoInitializeEx(pythoncom.COINIT_APARTMENTTHREADED)
    except Exception:
        pass

    excel = win32com.client.DispatchEx('Excel.Application')
    try:
        excel.Visible = False
    except Exception:
        pass
    try:
        excel.DisplayAlerts = False
    except Exception:
        pass

    docs = store.conn.execute(
        "SELECT document_id, filename, filepath FROM document"
    ).fetchall()

    ok = skip = fail = 0
    t0 = time.time()

    for di, doc in enumerate(docs, 1):
        doc_id = doc["document_id"]
        filepath = Path(doc["filepath"])
        filename = doc["filename"]

        if not filepath.exists():
            skip += 1
            continue

        # 이 문서의 HEADER/VALUE 노드들
        nodes = store.conn.execute('''
            SELECT node_id, node_name, node_type, tree_path, parent_node_id
            FROM tree_node
            WHERE document_id=? AND status='ACTIVE' AND node_type IN ('HEADER','VALUE')
            ORDER BY tree_path
        ''', (doc_id,)).fetchall()

        # tree_path에서 시트명 추출 → 시트별로 그룹
        sheet_nodes = {}
        for n in nodes:
            parts = n["tree_path"].split("/")
            if len(parts) >= 3:
                sname = parts[2]
                sheet_nodes.setdefault(sname, []).append(n)

        if not sheet_nodes:
            skip += 1
            continue

        try:
            wb = excel.Workbooks.Open(str(filepath.resolve()), 0, True)
            updated = 0

            for sname, snodes in sheet_nodes.items():
                # 시트 찾기
                ws = None
                for si in range(1, wb.Sheets.Count + 1):
                    if wb.Sheets(si).Name == sname:
                        ws = wb.Sheets(si)
                        break
                if ws is None:
                    continue

                used = ws.UsedRange
                if not used:
                    continue

                # 전체 값 읽기 (한 번에)
                max_r = used.Rows.Count
                max_c = used.Columns.Count
                if max_r == 0 or max_c == 0:
                    continue

                try:
                    data_range = ws.Range(ws.Cells(1, 1), ws.Cells(max_r, max_c))
                    values = data_range.Value
                except Exception:
                    continue

                # 값→셀주소 맵 구축
                val_to_cells = {}
                for r_idx, row_data in enumerate(values, 1):
                    if row_data is None:
                        continue
                    for c_idx, val in enumerate(row_data, 1):
                        if val is None:
                            continue
                        v_str = str(val).strip()
                        if v_str:
                            addr = f"{get_column_letter(c_idx)}{r_idx}"
                            val_to_cells.setdefault(v_str, []).append(addr)

                # 각 노드의 node_name으로 셀 주소 찾기
                for n in snodes:
                    name = n["node_name"].strip()
                    # node_name이 셀 값과 정확히 일치하는지
                    addrs = val_to_cells.get(name, [])
                    if addrs:
                        # 첫 번째 매칭 셀 사용
                        locator = f"{sname}!{addrs[0]}"
                        store.conn.execute(
                            "UPDATE tree_node SET locator=? WHERE node_id=?",
                            (locator, n["node_id"]))
                        updated += 1
                        # 사용한 주소는 제거 (중복 방지)
                        addrs.pop(0)

            wb.Close(SaveChanges=False)
            ok += 1
            if di % 5 == 0:
                print(f"  [{di}/{len(docs)}] {updated} locators updated")

        except Exception as e:
            fail += 1
            print(f"  [{di}/{len(docs)}] FAIL {filename[:40]} - {e}")

    try:
        excel.Quit()
    except Exception:
        pass

    store.commit()
    elapsed = time.time() - t0
    print(f"\n완료: {ok} ok, {skip} skip, {fail} fail, {elapsed:.1f}s")

    # 결과
    with_loc = store.conn.execute('''
        SELECT count(*) FROM tree_node 
        WHERE status='ACTIVE' AND locator IS NOT NULL AND locator != '' AND locator LIKE '%!%'
    ''').fetchone()[0]
    total = store.conn.execute('''
        SELECT count(*) FROM tree_node WHERE status='ACTIVE' AND node_type IN ('HEADER','VALUE')
    ''').fetchone()[0]
    print(f"Locator: {with_loc}/{total} nodes have cell addresses")

if __name__ == "__main__":
    main()
