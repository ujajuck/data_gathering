"""python -m kg.v3 [serve] --ws <ws> --port 8031 [--host 127.0.0.1]
python -m kg.v3 render-serve --ws <ws> --port 8032 [--host 127.0.0.1]
python -m kg.v3 watch --ws <ws> [--raw DIR] [--interval 2] [--once] [--provider local-xlsx]
python -m kg.v3 migrate --ws <v3 ws> --from-ws <v2 ws> [--dry-run] [--report PATH]
python -m kg.v3 import-schema --ws <ws> --file schema.json
python -m kg.v3 import-profile --ws <ws> --schema <schema_key> --file profile.json [--format auto] [--name NAME] [--profile PROFILE_ID]
python -m kg.v3 build --ws <ws> --schema <schema_key> --documents <id> ... [--columns field_key[=header[:unit]] ...] [--row-mode record] --format xlsx --out DIR
python -m kg.v3 seed-demo --workspace <ws>

모두 시작 시 `.env`를 읽는다(kg/env.py). 계약 §10."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from ..env import load_env
from .db import Problem

COMMANDS = ("serve", "render-serve", "watch", "migrate", "import-schema", "import-profile", "build", "seed-demo")


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m kg.v3", description="Semantic Excel Integration v3")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="API/UI 서버 실행 (기본)")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8031)
    serve.add_argument("--host", default="127.0.0.1")

    render = sub.add_parser("render-serve", help="렌더 서버(별도 프로세스) 실행")
    render.add_argument("--ws", type=Path, default=Path("."))
    render.add_argument("--port", type=int, default=8032)
    render.add_argument("--host", default="127.0.0.1")

    watch = sub.add_parser("watch", help="raw 폴더 감시 → 등록 + 자동 적용")
    watch.add_argument("--ws", type=Path, required=True)
    watch.add_argument("--raw", type=Path, default=None, help="기본 <ws>/data/raw; 그 아래 폴더만 허용")
    watch.add_argument("--interval", type=float, default=2.0)
    watch.add_argument("--once", action="store_true", help="스캔 2회 후 종료(테스트/원샷)")
    watch.add_argument("--provider", default="local-xlsx")

    mig = sub.add_parser("migrate", help="v2 작업 공간 → v3 이관")
    mig.add_argument("--ws", type=Path, required=True)
    mig.add_argument("--from-ws", dest="from_ws", type=Path, required=True)
    mig.add_argument("--dry-run", dest="dry_run", action="store_true")
    mig.add_argument("--report", type=Path, default=None)
    mig.add_argument("--principal", default="v2-migration")

    schema = sub.add_parser("import-schema", help="파싱 스키마 정의 파일 가져오기(새 리비전)")
    schema.add_argument("--ws", type=Path, required=True)
    schema.add_argument("--file", type=Path, required=True)

    profile = sub.add_parser("import-profile", help="파싱 프로파일 정의 가져오기(3.0/v2/v1/generic)")
    profile.add_argument("--ws", type=Path, required=True)
    profile.add_argument("--schema", required=True, help="대상 schema_key")
    profile.add_argument("--file", type=Path, required=True)
    profile.add_argument("--format", default="auto")
    profile.add_argument("--name", default=None)
    profile.add_argument("--profile", default=None, help="기존 프로파일에 새 리비전으로 저장할 profile_id")

    build = sub.add_parser("build", help="데이터 빌드 산출물 생성")
    build.add_argument("--ws", type=Path, required=True)
    build.add_argument("--schema", required=True)
    build.add_argument("--documents", nargs="+", required=True, help="document_id 목록")
    build.add_argument("--columns", nargs="*", default=None, help="field_key[=header[:target_unit]] (생략 시 스키마의 active 필드 전부)")
    build.add_argument("--row-mode", dest="row_mode", choices=("record", "document"), default="record")
    build.add_argument("--format", choices=("csv", "xlsx", "sqlite"), default="xlsx")
    build.add_argument("--out", type=Path, required=True)

    seed = sub.add_parser("seed-demo", help="E2E/데모 작업 공간 시드(계약 §8)")
    seed.add_argument("--workspace", type=Path, required=True)
    return parser


def normalize_argv(argv):
    # 서브커맨드 없이 --ws/--port만 주던 호출(python -m kg.v3 --ws X --port N)은 serve로 해석한다.
    argv = list(argv)
    if not argv or (argv[0] not in COMMANDS and argv[0] not in ("-h", "--help")):
        argv = ["serve", *argv]
    return argv


def parse(argv=None):
    return build_parser().parse_args(normalize_argv(sys.argv[1:] if argv is None else argv))


parse_args = parse


def _read_json(path: Path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise Problem("INVALID_FILE", f"정의 파일을 읽을 수 없습니다: {exc}") from None


def _columns(service, schema_key, specs):
    """CLI 컬럼 표기 field_key[=header[:unit]] → build 입력. 생략 시 스키마의 active 비그룹 필드 전부."""
    fields = service.schema_fields(schema_key)
    if fields is None:
        raise Problem("UNKNOWN_SCHEMA", f"파싱 스키마 {schema_key!r}를 찾을 수 없습니다.", 404)
    if not specs:
        return [{"field_key": k, "header": f["name"]} for k, f in fields.items() if f["status"] == "active" and f["value_type"] != "group"]
    out = []
    for spec in specs:
        key, _, rest = spec.partition("=")
        header, _, unit = rest.partition(":")
        column = {"field_key": key, "header": header or (fields.get(key) or {}).get("name") or key}
        if unit:
            column["target_unit"] = unit
        out.append(column)
    return out


def run_build(args):
    from .service import Service

    try:
        from .build import build
    except ImportError:
        raise Problem("NOT_AVAILABLE", "빌드 모듈(kg.v3.build)이 아직 없습니다.", 501) from None
    service = Service(args.ws)
    try:
        request = {
            "document_ids": list(args.documents),
            "schema_key": args.schema,
            "columns": _columns(service, args.schema, args.columns),
            "row_mode": args.row_mode,
            "format": args.format,
        }
        result = build(service, request)
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        copied = []
        # 산출물은 <ws>/data/exports/<build_key>/에 있으므로 --out으로 복사만 한다.
        source_dir = service.root / "data/exports" / result["build_key"]
        for name in ("data.csv", "data.xlsx", "data.sqlite", "manifest.json"):
            if (source_dir / name).is_file():
                shutil.copy2(source_dir / name, out / name)
                copied.append(str(out / name))
        return {"build_key": result["build_key"], "row_count": result.get("row_count", (result.get("manifest") or {}).get("row_count")), "files": copied}
    finally:
        service.close()


def main(argv=None):
    args = parse(argv)
    load_env(getattr(args, "ws", None) or getattr(args, "workspace", None) or ".", ".")
    if args.command == "serve":
        import uvicorn

        from .api import create_app

        uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
        return 0
    if args.command == "render-serve":
        from .render.server import serve

        serve(args.ws, host=args.host, port=args.port)
        return 0
    if args.command == "watch":
        try:
            from .watch import run
        except ImportError:
            print("watch는 아직 제공되지 않습니다(kg.v3.watch 없음).", file=sys.stderr)
            return 2
        return run(args.ws, args.raw, provider=args.provider, interval=args.interval, once=args.once)
    if args.command == "migrate":
        try:
            from .migrate import run_cli
        except ImportError:
            print("migrate는 아직 제공되지 않습니다(kg.v3.migrate 없음).", file=sys.stderr)
            return 2
        return run_cli(args)
    try:
        if args.command == "seed-demo":
            from examples.schema_v3.demo import seed

            result = seed(args.workspace.resolve())
        elif args.command == "import-schema":
            from .service import Service

            service = Service(args.ws)
            try:
                result = service.import_schema(_read_json(args.file))
            finally:
                service.close()
        elif args.command == "import-profile":
            from .service import Service

            service = Service(args.ws)
            try:
                result = service.import_profile(args.schema, _read_json(args.file), args.format, profile_id=args.profile, name=args.name)
            finally:
                service.close()
        else:
            result = run_build(args)
    except Problem as exc:
        print(json.dumps({"error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    # Reader 자식 프로세스(spawn)가 main 모듈을 재임포트해도 서버가 다시 실행되지 않게 한다.
    raise SystemExit(main())
