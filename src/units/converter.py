"""Deterministic unit parsing/conversion (설계문서 §13 src.units).

원본값·원본단위와 정규화값·표준단위를 모두 보존하는 결정론적 변환만 수행한다.
선형(factor)과 아핀(factor+offset — K, °F) 변환을 지원한다:
    base = value * factor + offset
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

    def dimension_of(self, unit: str | None) -> str | None:
        """대표 차원 하나 (다중 차원이면 임의) — 존재 여부 확인용."""
        dims = self.dimensions_of(unit)
        return sorted(dims)[0] if dims else None

    def in_dimension(self, unit: str | None, dimension: str) -> bool:
        return dimension in self.dimensions_of(unit)

    def compatible(self, unit_a: str | None, unit_b: str | None) -> bool:
        return bool(self.dimensions_of(unit_a) & self.dimensions_of(unit_b))

    def convert(self, value: float, from_unit: str, to_unit: str) -> float:
        """Convert within one shared dimension; raises on incompatible units."""
        fu, tu = self.normalize_unit(from_unit), self.normalize_unit(to_unit)
        if fu == tu:
            return value
        shared = self.dimensions_of(fu) & self.dimensions_of(tu)
        if not shared:
            raise ValueError(f"incompatible units: {from_unit} -> {to_unit}")
        dim = sorted(shared)[0]
        f_from, o_from = self._params[(dim, fu)]
        f_to, o_to = self._params[(dim, tu)]
        base = value * f_from + o_from
        return (base - o_to) / f_to
