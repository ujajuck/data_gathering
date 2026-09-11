"""python -m kg.v2 [serve] --ws <ws> --port 8010
python -m kg.v2 watch --ws <ws> [--raw DIR] [--interval 2] [--once] [--provider local-xlsx]
python -m kg.v2 migrate --ws <v2 ws> --from-ws <v1 ws> [--raw DIR] [--dry-run] [--report PATH]
python -m kg.v2 sign --ws <ws> [--version <document_version_id>]
python -m kg.v2 export --ws <ws> --build <build_id> --out <dir>
python -m kg.v2 age-projection --ws <ws> --kg current --out <file.sql>"""

import argparse
import json
import os
import sys
from pathlib import Path

from ..env import load_env
from .db import Problem

COMMANDS = ("serve", "watch", "migrate", "sign", "export", "age-projection")


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m kg.v2", description="Data Gathering v2")
    sub = parser.add_subparsers(dest="command")

    serve = sub.add_parser("serve", help="API/UI 서버 실행 (기본)")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8010)
    serve.add_argument("--host", default="127.0.0.1")

    watch = sub.add_parser("watch", help="raw 폴더 감시 → v2 문서 버전 자동 등록")
    watch.add_argument("--ws", type=Path, required=True)
    watch.add_argument("--raw", type=Path, default=None, help="기본 <ws>/data/raw; 그 아래 폴더만 허용")
    watch.add_argument("--interval", type=float, default=2.0)
    watch.add_argument("--once", action="store_true", help="스캔 2회 후 종료(테스트/원샷)")
    watch.add_argument("--provider", default="local-xlsx")

    mig = sub.add_parser("migrate", help="v1 kg.db → v2 이관")
    mig.add_argument("--ws", type=Path, required=True)
    mig.add_argument("--from-ws", dest="from_ws", type=Path, required=True)
    mig.add_argument("--raw", type=Path, default=None)
    mig.add_argument("--dry-run", dest="dry_run", action="store_true")
    mig.add_argument("--report", type=Path, default=None)
    mig.add_argument("--principal", default="v1-migration")

    sign = sub.add_parser("sign", help="서명이 없는 현재 문서 버전의 구조 서명을 계산한다")
    sign.add_argument("--ws", type=Path, default=Path("."))
    sign.add_argument("--version", default=None)

    export = sub.add_parser("export", help="완료된 빌드를 DVC 추적 폴더로 내보내기")
    export.add_argument("--ws", type=Path, required=True)
    export.add_argument("--build", required=True)
    export.add_argument("--out", type=Path, required=True)

    age = sub.add_parser("age-projection", help="KG 리비전의 Apache AGE projection SQL 생성")
    age.add_argument("--ws", type=Path, required=True)
    age.add_argument("--kg", default="current", help="리비전 번호, kg_revision_id 또는 current")
    age.add_argument("--out", type=Path, required=True)
    age.add_argument("--graph", default=None)
    return parser


def normalize_argv(argv):
    # 서브커맨드 없이 --ws/--port만 주던 기존 호출(python -m kg.v2 --ws X --port N)은 serve로 해석한다.
    argv = list(argv)
    if not argv or (argv[0] not in COMMANDS and argv[0] not in ("-h", "--help")):
        argv = ["serve", *argv]
    return argv


def parse(argv=None):
    return build_parser().parse_args(normalize_argv(sys.argv[1:] if argv is None else argv))


parse_args = parse


def main(argv=None):
    args = parse(argv)
    # 작업 공간과 현재 폴더의 .env를 읽는다. 이미 export된 값이 우선이다.
    load_env(getattr(args, "ws", None) or ".", ".")
    principal = os.environ.get("KG_V2_PRINCIPAL", "local-user")
    if args.command == "watch":
        from .watch import run

        return run(args.ws, args.raw, provider=args.provider, interval=args.interval, once=args.once)
    if args.command == "migrate":
        from .migrate import run_cli

        return run_cli(args)
    if args.command == "sign":
        from .service import Service
        from .suggest import sign_versions

        for line in sign_versions(Service(args.ws), args.version, principal):
            print(line)
        return 0
    try:
        if args.command == "export":
            from .export import export_build
            from .service import Service

            result = export_build(Service(args.ws), args.build, args.out, principal)
        elif args.command == "age-projection":
            from .age_projection import write_projection

            result = write_projection(args.ws, args.kg, args.out, args.graph)
        else:
            import uvicorn

            from .api import create_app

            uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
            return 0
    except Problem as exc:
        print(
            json.dumps({"error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    # Reader 자식 프로세스(spawn)가 main 모듈을 재임포트해도 서버/감시가 다시 실행되지 않게 한다.
    raise SystemExit(main())
