"""python -m kg.v2 [serve] --ws domains/financier --port 8010
python -m kg.v2 sign --ws domains/financier [--version <document_version_id>]"""

import argparse
import os
import sys
from pathlib import Path


def build_parser():
    parser = argparse.ArgumentParser(prog="python -m kg.v2", description="Data Gathering v2")
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve", help="API 서버 실행")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8010)
    serve.add_argument("--host", default="127.0.0.1")
    sign = commands.add_parser(
        "sign", help="서명이 없는 현재 문서 버전의 구조 서명을 계산한다"
    )
    sign.add_argument("--ws", type=Path, default=Path("."))
    sign.add_argument("--version", default=None)
    return parser


def parse_args(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0].startswith("-"):
        # 기존 `python -m kg.v2 --ws X --port N` 호출 형식을 유지한다.
        argv = ["serve", *argv]
    return build_parser().parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    if args.command == "sign":
        from .service import Service
        from .suggest import sign_versions

        principal = os.environ.get("KG_V2_PRINCIPAL", "local-user")
        for line in sign_versions(Service(args.ws), args.version, principal):
            print(line)
        return
    import uvicorn
    from .api import create_app

    uvicorn.run(create_app(args.ws), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
