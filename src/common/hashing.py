"""Hash and cache-key helpers (설계문서 §5.4 재처리 캐시 키)."""
from __future__ import annotations

import hashlib
from pathlib import Path


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def semantic_cache_key(
    source_hash: str,
    parser_version: str,
    concept_dictionary_version: str,
    unit_rule_version: str,
) -> str:
    """Cache key that invalidates on dictionary/rule changes, not only raw changes."""
    raw = "|".join([source_hash, parser_version, concept_dictionary_version, unit_rule_version])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
