"""DRM 파일에서 render 데이터 추출 → sheet_render 캐시 저장.

ingest_from_parser.py는 tree_node만 만들고 render를 안 만드므로,
이 스크립트로 render 캐시를 별도로 채운다.
"""
import sys, os, json, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from kg.store import KgStore, stable_id

DB_PATH = Path(__file__).parent / "data" / "kg" / "kg.db"
DATA_DIR = Path(r"F:\재료데이터\data\MLCC조성Lab_유전체 개발_전장 재료_X7R_WS 평가_31B106KB_첨가제")

def main():
    import win32com.client
    import pythoncom
    from src.inspect.inspector import _extract_render

    store = KgStore(DB_PATH)
    docs = store.conn.execute(
        "SELECT document_id, filename, filepath FROM document"
    ).fetchall()

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

    ok = skip = fail = 0
    t0 = time.time()

    for i, doc in enumerate(docs, 1):
        doc_id = doc["document_id"]
        filepath = Path(doc["filepath"])
        filename = doc["filename"]

        # 이미 캐시 있으면 스킵
        existing = store.conn.execute(
            "SELECT 1 FROM sheet_render WHERE document_id=?", (doc_id,)
        ).fetchone()
        if existing:
            skip += 1
            continue

        if not filepath.exists():
            print(f"  [{i}/{len(docs)}] SKIP {filename[:50]} (file not found)")
            skip += 1
            continue

        try:
            wb = excel.Workbooks.Open(str(filepath.resolve()), 0, True)
            renders = []
            for si in range(1, wb.Sheets.Count + 1):
                ws = wb.Sheets(si)
                sname = ws.Name
                used = ws.UsedRange
                max_row = min(used.Rows.Count if used else 1, 300)
                max_col = min(used.Columns.Count if used else 1, 40)
                try:
                    render = _extract_render(ws, excel, max_row, max_col)
                    if render:
                        render["sheet"] = sname
                        renders.append((sname, json.dumps(render, ensure_ascii=False)))
                except Exception as e:
                    print(f"    render fail: {sname} - {e}")

            wb.Close(SaveChanges=False)

            # DB에 저장
            file_hash = "drm"
            for sname, rjson in renders:
                store.save_render(doc_id, sname, rjson, file_hash)
            store.commit()
            ok += 1
            print(f"  [{i}/{len(docs)}] OK   {filename[:50]} ({len(renders)} sheets)")
        except Exception as e:
            fail += 1
            print(f"  [{i}/{len(docs)}] FAIL {filename[:50]} - {e}")

    try:
        excel.Quit()
    except Exception:
        pass

    elapsed = time.time() - t0
    print(f"\n완료: {ok} ok, {skip} skip, {fail} fail, {elapsed:.1f}s")

if __name__ == "__main__":
    main()
