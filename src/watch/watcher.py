"""레거시 호환 셔틀 — watcher는 현행 파이프라인(kg.watch)으로 이관됐다.

src/는 Parser library로 축소한다(§이관 계획: docs/MIGRATION.md). 기존
import 경로(src.watch.watcher)는 당분간 이 re-export로 유지된다.
"""
from kg.watch import (FileEventWatcher, FileState, IngestEvent,  # noqa: F401
                      StabilityGuard, wait_until_stable)
