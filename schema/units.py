"""단위 변환표(`<ws>/config/units.yaml`) — 빌드가 값을 표준 단위로 맞출 때 쓴다.

단위 이름 정규화(별칭·조건 표기 제거), 단위가 속한 차원 조회, 차원 안의 변환 계수 제공만 한다.
선형(factor)과 아핀(factor+offset — K, °F)을 지원한다: `base = value * factor + offset`.
계산은 호출자(`schema/build.py`)가 Decimal로 한다 — 원본값·원본단위와 정규화값·표준단위를 모두 보존한다.
"""
from __future__ import annotations

import re
from pathlib import Path

import yaml

# "cP@25℃", "cP @25℃", "kWh/톤" 같은 조건/부가 표기를 떼어낸 코어 단위
_CONDITION_RE = re.compile(r"\s*@.*$")


def _parse_entry(entry) -> tuple[float, float]:
    """factor 또는 {factor, offset} → (factor, offset)."""
    if isinstance(entry, dict):
        return float(entry.get("factor", 1.0)), float(entry.get("offset", 0.0))
    return float(entry), 0.0


class UnitRegistry:
    def __init__(self, config: dict):
        self.version = str(config.get("version", "0"))
        self.aliases: dict[str, str] = config.get("aliases") or {}
        self.dimensions: dict[str, dict] = config.get("dimensions") or {}
        # 한 단위가 여러 차원에 속할 수 있다 (예: MPa는 pressure이자 strength)
        self._unit_dims: dict[str, set[str]] = {}
        self._params: dict[tuple[str, str], tuple[float, float]] = {}
        for dim, units in self.dimensions.items():
            for u, entry in (units or {}).items():
                self._unit_dims.setdefault(u, set()).add(dim)
                self._params[(dim, u)] = _parse_entry(entry)

    @classmethod
    def load(cls, path: Path) -> "UnitRegistry":
        with open(path, encoding="utf-8") as f:
            return cls(yaml.safe_load(f) or {})

    def normalize_unit(self, unit: str | None) -> str | None:
        if unit is None:
            return None
        u = unit.strip()
        u = _CONDITION_RE.sub("", u).strip()
        return self.aliases.get(u, u)

    def dimensions_of(self, unit: str | None) -> set[str]:
        u = self.normalize_unit(unit)
        return set(self._unit_dims.get(u, set())) if u else set()

    def factor_offset(self, dimension: str, unit: str) -> tuple[float, float]:
        """한 차원 안에서 `base = value * factor + offset`의 계수. 산술은 호출자가 한다(빌드는 Decimal)."""
        return self._params[(dimension, unit)]
