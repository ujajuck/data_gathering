"""Ingest MLCC additive checksheet files into the kg workspace."""
import sys, os, time
sys.path.insert(0, r"F:\llm\data_gathering")
os.chdir(r"F:\llm\data_gathering")

from pathlib import Path
from kg.tree.builder import load_workbook_tree
from kg.tree.diff import apply_tree
from kg.store import KgStore
from src.inspect.inspector import PARSER_VERSION
from src.units.converter import UnitRegistry
from src.mapping.concepts import ConceptRegistry

ws_root = Path("domains/mlcc_additive")
store = KgStore(ws_root / "data" / "kg" / "kg.db")
units = UnitRegistry.load(ws_root / "config" / "units.yaml")
registry = ConceptRegistry.load(ws_root / "config" / "concepts.yaml") if (ws_root / "config" / "concepts.yaml").exists() else None

data_dir = Path(r'F:\재료데이터\data\MLCC조성Lab_유전체 개발_전장 재료_X7R_WS 평가_31B106KB_첨가제')
files = sorted([f for f in data_dir.iterdir() if f.suffix in ('.xlsx', '.xls') and not f.name.startswith('~$')])

print(f"Processing {len(files)} files...")
success = fail = skip = 0
t_start = time.time()

for i, f in enumerate(files, 1):
    t0 = time.time()
    try:
        doc_id, drafts, file_hash = load_workbook_tree(
            store, ws_root, f, {}, units, registry)
        prev = store.latest_version(doc_id)
        if prev is not None and prev["file_hash"] == file_hash:
            skip += 1
            print(f"  [{i:2d}/{len(files)}] SKIP  {f.name[:55]}")
            continue
        diff = apply_tree(store, doc_id, f.name, str(f), file_hash, PARSER_VERSION, drafts)
        elapsed = time.time() - t0
        success += 1
        print(f"  [{i:2d}/{len(files)}] {elapsed:5.1f}s OK    {f.name[:55]}")
    except Exception as e:
        fail += 1
        print(f"  [{i:2d}/{len(files)}] ERROR {f.name[:55]}  {str(e)[:80]}")

total = time.time() - t_start
print(f"\nDone: {success} ok, {skip} skip, {fail} fail, {total:.0f}s ({total/60:.1f}min)")
