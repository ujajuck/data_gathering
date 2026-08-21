"""Deterministic unit parsing/conversion (설계문서 §13 src.units).

원본값·원본단위와 정규화값·표준단위를 모두 보존하는 결정론적 변환만 수행한다.
"""
from __future__ import annotations

from pathlib import Path

import yaml


class UnitRegistry:
    def __init__(self, config: dict):
        self.version = str(config.get("version", "0"))
        self.aliases: dict[str, str] = config.get("aliases") or {}
        self.dimensions: dict[str, dict[str, float]] = config.get("dimensions") or {}
        # 한 단위가 여러 차원에 속할 수 있다 (예: MPa는 pressure이자 strength)
        self._unit_dims: dict[str, set[str]] = {}
        for dim, units in self.dimensions.items():
            for u in (units or {}):
                self._unit_dims.setdefault(u, set()).add(dim)

    @classmethod
    def load(cls, path: Path) -> "UnitRegistry":
        with open(path, encoding="utf-8") as f:
            return cls(yaml.safe_load(f) or {})

    def normalize_unit(self, unit: str | None) -> str | None:
        if unit is None:
            return None
        u = unit.strip()
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
        factors = self.dimensions[sorted(shared)[0]]
        return value * factors[fu] / factors[tu]
