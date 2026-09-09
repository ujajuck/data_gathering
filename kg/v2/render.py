"""원본 렌더와 셀 선택 좌표가 같은 버전/범위에서 온 것인지 검증한다."""

import math

from .db import Problem
from .spec import bounds


def validate_viewport(view, request, token):
    def bad():
        raise Problem(
            "INVALID_RENDER_CONTRACT", "표시 범위와 원본 좌표가 일치하지 않습니다."
        )

    if (
        view.get("mode") not in ("native", "simplified")
        or view.get("layout_revision") != token
    ):
        bad()
    r1, c1 = request["r1"], request["c1"]
    r2, c2 = r1 + request["rows"] - 1, c1 + request["cols"] - 1
    if [view.get(k) for k in ("r1", "c1", "r2", "c2")] != [r1, c1, r2, c2]:
        bad()
    for key, count, start, pos, size in (
        ("rows", request["rows"], r1, "y", "height"),
        ("columns", request["cols"], c1, "x", "width"),
    ):
        dims = view.get(key, [])
        if len(dims) != count:
            bad()
        end = 0
        for n, dim in enumerate(dims):
            if (
                dim.get("index") != start + n
                or not isinstance(dim.get(pos), (int, float))
                or not math.isclose(dim[pos], end, abs_tol=1e-6)
                or not isinstance(dim.get(size), (int, float))
                or not math.isfinite(dim[size])
                or not 0 <= dim[size] <= 100000
            ):
                bad()
            end += dim[size]
        if (
            not isinstance(view.get(size), (int, float))
            or not math.isclose(view[size], end, abs_tol=1e-6)
            or end > 1000000
        ):
            bad()
    if (
        not isinstance(view.get("cells"), list)
        or len(view["cells"]) > request["rows"] * request["cols"]
    ):
        bad()
    covered = set()
    for cell in view["cells"]:
        box = bounds(cell.get("range"))
        if (
            list(box) != [cell.get(k) for k in ("r1", "c1", "r2", "c2")]
            or box[2] < r1
            or box[0] > r2
            or box[3] < c1
            or box[1] > c2
        ):
            bad()
        for key in ("x", "y", "width", "height"):
            if (
                not isinstance(cell.get(key), (int, float))
                or not math.isfinite(cell[key])
                or abs(cell[key]) > 100000000
            ):
                bad()
        for r in range(max(r1, box[0]), min(r2, box[2]) + 1):
            for c in range(max(c1, box[1]), min(c2, box[3]) + 1):
                if (r, c) in covered:
                    bad()
                covered.add((r, c))
        first_row, last_row = (
            view["rows"][max(r1, box[0]) - r1],
            view["rows"][min(r2, box[2]) - r1],
        )
        first_col, last_col = (
            view["columns"][max(c1, box[1]) - c1],
            view["columns"][min(c2, box[3]) - c1],
        )
        actual = [
            max(0, cell["x"]),
            max(0, cell["y"]),
            min(view["width"], cell["x"] + cell["width"]),
            min(view["height"], cell["y"] + cell["height"]),
        ]
        expected = [
            first_col["x"],
            first_row["y"],
            last_col["x"] + last_col["width"],
            last_row["y"] + last_row["height"],
        ]
        if not all(math.isclose(a, b, abs_tol=1e-6) for a, b in zip(actual, expected)):
            bad()
    if len(covered) != request["rows"] * request["cols"]:
        bad()
    images = view.get("images")
    if not isinstance(images, list) or len(images) > 100:
        bad()
    for picture in images:
        if not isinstance(picture.get("data_url"), str) or not picture[
            "data_url"
        ].startswith(
            (
                "data:image/png;base64,",
                "data:image/jpeg;base64,",
                "data:image/gif;base64,",
            )
        ):
            bad()
        if any(
            not isinstance(picture.get(k), (int, float))
            or not math.isfinite(picture[k])
            or abs(picture[k]) > 100000000
            for k in ("x", "y", "width", "height")
        ):
            bad()
    if view["mode"] == "native" and (not images or not view["cells"]):
        bad()
