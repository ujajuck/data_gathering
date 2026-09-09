"""python -m kg.v2 [serve] --ws domains/financier --port 8010
python -m kg.v2 export --ws <ws> --build <build_id> --out <dir>
python -m kg.v2 age-projection --ws <ws> --kg current --out <file.sql>"""

import argparse
import json
import os
import sys
from pathlib import Path

from .db import Problem

COMMANDS = ("serve", "export", "age-projection")


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m kg.v2", description="Data Gathering v2")
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="API/UI 서버 실행 (기본)")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8010)
    serve.add_argument("--host", default="127.0.0.1")
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


def parse(argv):
    argv = list(argv)
    # 기존 호출 형태(python -m kg.v2 --ws X --port N)를 보존한다.
    if not argv or (argv[0] not in COMMANDS and argv[0] not in ("-h", "--help")):
        argv = ["serve", *argv]
    return build_parser().parse_args(argv)


def main(argv=None):
    args = parse(sys.argv[1:] if argv is None else argv)
    try:
        if args.command == "export":
            from .export import export_build
            from .service import Service

            result = export_build(
                Service(args.ws),
                args.build,
                args.out,
                os.environ.get("KG_V2_PRINCIPAL", "local-user"),
            )
        elif args.command == "age-projection":
            from .age_projection import write_projection

            result = write_projection(args.ws, args.kg, args.out, args.graph)
        else:
            import uvicorn

            from .api import create_app

            uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
            return
    except Problem as exc:
        print(
            json.dumps({"error": {"code": exc.code, "message": exc.message}}, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(2)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
