"""python -m kg.v2 --ws domains/financier --port 8010
python -m kg.v2 migrate --ws <v2 workspace> --from-ws <v1 workspace> [--raw DIR] [--dry-run] [--report PATH]"""

import argparse
import sys
from pathlib import Path

COMMANDS = ("serve", "migrate")


def build_parser():
    parser = argparse.ArgumentParser(prog="kg.v2", description="Data Gathering v2")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="v2 API 서버")
    serve.add_argument("--ws", type=Path, default=Path("."))
    serve.add_argument("--port", type=int, default=8010)
    serve.add_argument("--host", default="127.0.0.1")
    mig = sub.add_parser("migrate", help="v1 kg.db → v2 이관")
    mig.add_argument("--ws", type=Path, required=True)
    mig.add_argument("--from-ws", dest="from_ws", type=Path, required=True)
    mig.add_argument("--raw", type=Path, default=None)
    mig.add_argument("--dry-run", dest="dry_run", action="store_true")
    mig.add_argument("--report", type=Path, default=None)
    mig.add_argument("--principal", default="v1-migration")
    return parser


def normalize_argv(argv):
    # 서브커맨드 없이 --ws/--port만 주던 기존 호출은 serve로 해석한다.
    argv = list(argv)
    if not argv or (argv[0] not in COMMANDS and argv[0] not in ("-h", "--help")):
        argv = ["serve", *argv]
    return argv


def main(argv=None):
    args = build_parser().parse_args(
        normalize_argv(sys.argv[1:] if argv is None else argv)
    )
    if args.command == "migrate":
        from .migrate import run_cli

        return run_cli(args)
    import uvicorn
    from .api import create_app

    uvicorn.run(create_app(args.ws), host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
