"""python -m kg.v2 --ws domains/financier --port 8010"""

import argparse
from pathlib import Path


def main():
    import uvicorn
    from .api import create_app

    parser = argparse.ArgumentParser(description="Data Gathering v2")
    parser.add_argument("--ws", type=Path, default=Path("."))
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(create_app(args.ws), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
