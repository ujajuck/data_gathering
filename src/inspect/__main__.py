"""DVC stage: inspect — 원본 구조 추출 (설계문서 §8.5 dvc.yaml).

python -m src.inspect --input data/raw --out data/staging/structure.jsonl
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from src.common.models import to_jsonable
from src.inspect.inspector import WorkbookInspector


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    inspector = WorkbookInspector()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        for p in sorted(Path(args.input).glob("*.xlsx")):
            if p.name.startswith("~$"):
                continue
            st = inspector.inspect(p, relative_to=args.input.parent.parent if args.input.parent.name == "data" else None)
            f.write(json.dumps(to_jsonable(st), ensure_ascii=False, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
