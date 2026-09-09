"""E2E 전용 가상 문서를 임시 작업 공간에 생성한다. 실제 도메인 DB는 열지 않는다."""

from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main():
    import uvicorn
    from examples.schema_v2.runtime_demo import seed
    from kg.v2.api import create_app

    with tempfile.TemporaryDirectory(prefix="kg-v2-e2e-") as directory:
        root = Path(directory)
        seed(root)
        uvicorn.run(create_app(root), host="127.0.0.1", port=8021)


if __name__ == "__main__":
    main()
