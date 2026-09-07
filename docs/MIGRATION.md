# 레거시(src) → 현행(kg) 정리 계획

저장소에는 두 세대가 공존했다: `src/`(초기 Canonical DB / DVC 파이프라인)와
`kg/`(현행 Fixed KG 기반 시스템). 목표였던 **단일 파이프라인 + `src/`의
Parser library 축소**는 Phase 1 완료로 달성됐다.

```
목표 아키텍처 (단일 파이프라인) — 달성

  Input / Versioning        dvc add data/raw · kg.cli watch · DRM 게이트
          │
          ▼
      Parser API            src/{inspect,segment,units,common,mapping}
          │                 = §14.1 Parser 계약 (Parser library)
          ▼
      Document KG           kg/ — tree/payload (구조 보존 적재)
          │
          ▼
      Semantic Layer        kg/ — 매핑·문서군·템플릿·정규화·통합 빌드
```

## 모듈 처분표

| 영역 | 모듈 | 처분 | 상태 |
|---|---|---|---|
| **Parser library (유지)** | `src/inspect` `src/segment` `src/units` `src/common` `src/mapping` | kg가 §14.1 계약으로 사용하는 코어 — 이후 계층에 비종속. `src/mapping/record_builder.py`(RecordBuilder)는 구 canonicalize에서 이동 — survey의 dry-run 매핑 엔진 | 현행 |
| | `src/survey` | 파서 코어 위 dry-run 어휘 조사. 진입점은 `kg.cli survey`(구 src.cli survey의 이관) | 현행 |
| **이관 완료** | `src/watch` → `kg/watch.py` | watcher는 현행 파이프라인 소속. `kg.cli watch`가 raw 폴링→자동 ingest(+map)+DRM 해제 감지. `src.watch.watcher`는 re-export 셔틀(호환) | ✅ 2026-09-06 |
| | `dvc.yaml` | 현행 `kg_ingest` 스테이지로 교체. `dvc add data/raw` 원본 버전닝은 시스템 중립으로 유지 | ✅ 2026-09-06 |
| **kg가 이미 흡수 (이관 불요)** | 구 `src/pipeline`의 semantic cache | 같은 역할이 kg에 내장됨 — ①ingest 파일 해시 스킵+매핑 승계(동일 원본 재적재), ②빌드 서명 재사용(동일 입력 재빌드 즉시 반환). 별도 캐시 파일 불요 | — |
| **삭제 완료 (Phase 1)** | `src/api`(7뷰 서버) `src/canonicalize` `src/loader` `src/export` `src/pipeline` `src/cli` `src/dvc_adapter` `web/` `scripts/build_report.py` `dvc.legacy.yaml` + 대응 레거시 테스트 7종 | 소유자 승인 후 일괄 삭제. *데이터 손실 없음* — 레거시 canonical DB는 파생 산출물이며 원본(data/raw)과 kg.db가 진실 | ✅ 2026-09-07 |

## 단계

- **Phase 0 (완료)** — watcher 이관, DVC 현행화, 이 문서로 경계 선언.
- **Phase 1 (완료, 2026-09-07)** — 유지보수 모드 모듈 + 대응 레거시 테스트
  일괄 삭제. 동반 조치: RecordBuilder를 `src/mapping/record_builder.py`로
  이동(survey 의존 유지), survey 진입점을 `kg.cli survey`로 이관,
  README/.gitignore의 레거시 표기 제거, 레거시 웹 계획서(docs/WEB_PLAN.md) 삭제.
- **Phase 2 (선택)** — `src/` → `parser/` 패키지 개명. 임포트 전면 수정
  대비 이득이 작아 필요성 재평가.

## 규칙

1. Parser library(위 표의 유지 코어)는 kg 계층에 의존하지 않는다
   (역방향 의존 금지 — watch 셔틀은 한시적 예외).
2. 이 표가 바뀌면 같은 커밋에서 README·ARCHITECTURE를 함께 갱신한다.
