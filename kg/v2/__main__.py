"""python -m kg.v2 [serve] --ws <ws> --port 8010
python -m kg.v2 watch --ws <ws> [--raw DIR] [--interval 2] [--once] [--provider local-xlsx]"""

import argparse
import sys
from pathlib import Path

COMMANDS = ("serve", "watch")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="python -m kg.v2", description="Data Gathering v2"
    )
    sub = parser.add_subparsers(dest="command")
    serve = sub.add_parser("serve", help="API 서버 실행(기본 동작)")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8010)
    serve.add_argument("--host", default="127.0.0.1")
    watch = sub.add_parser("watch", help="raw 폴더 감시 → v2 문서 버전 자동 등록")
    watch.add_argument("--ws", type=Path, required=True)
    watch.add_argument(
        "--raw", type=Path, default=None, help="기본 <ws>/data/raw; 그 아래 폴더만 허용"
    )
    watch.add_argument("--interval", type=float, default=2.0)
    watch.add_argument(
        "--once", action="store_true", help="스캔 2회 후 종료(테스트/원샷)"
    )
    watch.add_argument("--provider", default="local-xlsx")
    return parser


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in (*COMMANDS, "-h", "--help"):
        argv = ["serve", *argv]  # 기존 `python -m kg.v2 --ws X --port N` 호환
    args = build_parser().parse_args(argv)
    if args.command == "watch":
        from .watch import run

        return run(
            args.ws,
            args.raw,
            provider=args.provider,
            interval=args.interval,
            once=args.once,
        )
    import uvicorn
    from .api import create_app

    uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    # Reader 자식 프로세스(spawn)가 main 모듈을 재임포트해도 서버/감시가 다시 실행되지 않게 한다.
    raise SystemExit(main())
