# 보호 문서(DRM) 연동 — 지금 되는 것, 해제 경로 세 가지, 담당자 확인 목록

작성일: 2026-09-14 · 계약 [contracts.md](contracts.md) §3.5 · 배경 [drm-viewer-render-architecture.md](drm-viewer-render-architecture.md)

이 문서는 **확인된 것과 확인되지 않은 것을 나눠 적는다**. 벤더 제품의 기능은 운영 담당자에게 확인하기 전까지
사실로 쓰지 않는다 — 공개 자료에서 본 것은 그렇게 표시하고, 확인이 필요한 항목은 §5 체크리스트로 돌린다.

---

## 1. 전제가 뒤집혔다

이전 구현은 파일 앞 두 바이트가 `PK`가 아니면 그 자리에서 `DRM_READER_REQUIRED`로 잠그고 끝냈다.
해제 경로는 `SCHEMA_READER_FACTORY`라는 빈 자리로만 있었고 구현이 없었으므로, 실제로는
**보호 문서를 하나도 읽지 못하는 제품**이었다.

지금은 반대다.

| | 이전 | 지금 |
|---|---|---|
| 기본 가정 | 평문이 기본, DRM이 예외 | **보호 문서가 기본, 평문 OOXML이 예외** |
| 판별 | `PK` 아니면 잠김 | 앞 32바이트로 컨테이너 판별(§3.5(1)), 모르면 보호 문서로 본다 |
| 보호 문서 | 잠금으로 끝 | 등록된 Reader로 **넘긴다**. Reader가 없을 때만 잠금 |
| 오류 문구 | "암호화 문서입니다" | 무엇을 설정해야 하는지 말한다(`SCHEMA_READER_FACTORY`, 설정 화면 Reader 카드) |
| 해제 비용 | (없음) | snapshot당 **1회**. 같은 snapshot의 describe·match·extract·render가 한 해제본을 나눠 쓴다 |

---

## 2. 지금 무엇이 되고 무엇이 안 되는가

### 되는 것 (이 저장소 안에서 검증됨 — `tests/test_drm.py`)

- **컨테이너 판별** `schema/drm.py: sniff_container` — 운영자 시그니처(`SCHEMA_DRM_MAGIC`) → `PK` → OLE2 → 그 밖.
  판별 결과는 "평문으로 바로 열 수 있는가"만 말한다. 암호화된 OOXML도 OLE2 컨테이너라 매직만으로 구형 `.xls`와
  구분되지 않는다 — **둘 다 보호 문서로 보고 Reader에게 맡긴다**.
- **Reader 선택** `schema/readers.py: make_reader` — 판정은 이 한 곳에서만 한다. `XlsxReader.authorize`는 더 이상
  컨테이너로 잠그지 않는다(두 곳에서 판정하면 어댑터를 붙여도 계속 잠기는 화면이 남는다).
- **해제 세션 캐시** `schema/drm.py: SessionCache`/`DecryptedSession` — 키는 `(provider, source_ref, expected_token)`이고
  `expected_token`이 `document_snapshot.change_token`이므로 **한 snapshot = 세션 하나**다. Reader는 연산마다 별도
  프로세스에서 돌기 때문에 재사용은 메모리가 아니라 **파일**로 이뤄진다.
- **해제본 격리** — 작업 공간 밖 `SCHEMA_DRM_TEMP_DIR`(폴더 0700 · 파일 0600). 파일 이름은
  `sha256(provider|source_ref|token)` 앞 32자라 원본 이름·경로·사용자 이름을 담지 않는다. 임시 폴더가 작업 공간 안을
  가리키면 `DRM_TEMP_IN_WORKSPACE`로 멈춘다.
- **감사** — 보호 문서 접근마다 `<ws>/data/audit/drm-<YYYYMMDD>.jsonl`에 한 줄(성공·실패 모두).
  작업 결과에는 `result_json.drm = {unlocked, reused, failed}`가 붙는다.
- **점검 명령** `python -m schema drm-probe` — 어댑터 연결·임시 폴더·시그니처·파일별 판별을 한 번에 본다.
- **Excel COM 참조 구현** `schema/drm.py: ExcelComReader` — 절차(Open → SaveAs 51 → 시트 Copy 폴백 → Quit)와 제약
  (동시 실행 1·읽기 전용·`DisplayAlerts=False`·finally `Close`/`Quit`)이 코드로 적혀 있고, **기본으로 연결되지 않는다**.

### 안 되는 것 (정직하게)

- **실제 벤더 DRM은 하나도 붙어 있지 않다.** 이 저장소에는 벤더 SDK도, 벤더 라이선스도, 벤더 컨테이너 샘플도 없다.
  보호 문서를 실제로 여는 코드는 운영자가 `SCHEMA_READER_FACTORY`로 연결하는 어댑터뿐이다.
- **Excel COM 경로는 Windows에서 한 번도 실행되지 않았다.** 이 저장소의 CI와 개발 환경은 리눅스다.
  `ExcelComReader`는 비윈도우에서 import만 되고, 쓰면 "Windows + Excel + 대화형 로그인 세션이 필요하다"는 오류를 낸다.
  검증도 거기까지다 — `tests/test_drm.py`의 COM 테스트는 비윈도우에서 import와 오류 문구만 확인하고 **Windows에서는 skip한다**.
  즉 Windows 실행 경로를 검증하는 테스트는 아직 **없다**. Windows 서버에서 `pytest`가 통과해도 COM 경로가 검증된 것이 아니다.
- **`SCHEMA_DRM_MAGIC`의 실제 벤더 시그니처 값을 모른다.** 형식(`hex:`/`ascii:`)만 정했다. 값은 §5에서 받아야 한다.
- **해제 5초라는 수치는 이 저장소에서 측정한 값이 아니다.** [drm-viewer-render-architecture.md](drm-viewer-render-architecture.md) §1의
  실사용 보고를 그대로 인용한 것이고, 설계(“snapshot당 1회”)의 근거로만 쓴다. 실측은 `drm-probe --unlock`의 `unlock_ms`로 받는다.

---

## 3. 해제 경로 세 가지

어느 경로를 쓰든 이 시스템이 보는 인터페이스는 하나다 — `SCHEMA_READER_FACTORY`가 가리키는 팩토리가
`§3.2` 연산(`authorize`·`describe`·`match`·`match_specs`·`extract`·`render`)을 구현한다. 권장 구현은 §3.5(5)대로
`SessionCache.acquire`로 평문 파일을 얻고 나머지는 `XlsxReader`에 위임하는 것이다(엔진·렌더러를 다시 쓰지 않는다).

### (A) 벤더 복호화 API/SDK를 서버에서 호출

```text
Main API / Render Server ──(서버측 복호화 API)──> 평문 바이트 ──> 세션 파일 ──> XlsxReader
```

- **장점**: 리눅스 서버에서 돈다. Excel도, 대화형 로그인 세션도, 동시 실행 1 제약도 필요 없다. 실패 모드가 단순하다
  (권한 없음 / 만료 / 네트워크). 감사도 벤더 쪽과 이 쪽 양쪽에 남는다.
- **단점·전제**: 벤더가 **서버측 복호화 API 또는 서버용 SDK를 제공해야** 한다. 서비스 계정에 복호화 권한을 줄 수 있어야
  하고, 그 권한이 "사람 한 명"이 아니라 "등록 시스템"에 부여되는 모델이어야 한다.
- **확인 필요**: 이 두 가지는 제품·계약에 따라 갈린다. §5의 2·3·4번.
- 이 경로가 가능하면 **1순위**다. 나머지 둘은 이 경로가 막혔을 때의 우회다.

### (B) 윈도우 Excel COM 워커

```text
Main API ──(내부 HTTP)──> Windows 렌더/해제 워커 ──> Excel COM Open → SaveAs(51) ──> 세션 파일 ──> XlsxReader
```

- **장점**: 벤더 API 없이도 된다. DRM 클라이언트가 설치된 PC에서 사용자가 Excel로 열 수 있는 문서라면 대체로 열린다.
  이전 세대 구현에서 실제로 동작한 경로다(`Open → Sheet.Copy → SaveAs → openpyxl`).
- **단점·전제**:
  - **마이크로소프트는 서버측 Office 자동화를 지원하지 않는다.** 이것은 공개된 마이크로소프트의 지원 방침이고
    (서버 사이드 Office 자동화는 지원되지 않으며 권장되지 않는다는 문서), 무인 서비스 계정·세션 0에서 Office를
    자동화하면 대화 상자 대기·라이선스·프로파일 문제로 멈추거나 프로세스가 쌓인다.
  - 그래서 COM 워커는 **서비스가 아니라 자동 로그온된 대화형 세션**에서 돌려야 하고, **동시 실행은 1**로 묶어야 한다
    (`SCHEMA_RENDER_CONCURRENCY=1` + `SCHEMA_DRM_COM_LOCK` 잠금 파일). DRM 클라이언트가 대화형 사용자 토큰을
    요구하는 경우가 많다는 점도 같은 방향을 가리킨다 — 다만 이 부분은 제품마다 다르므로 §5의 3번으로 확인한다.
  - Windows 라이선스·Excel 라이선스·물리(또는 항상 로그온된 가상) 머신 한 대가 상시 필요하다.
  - 정책이 "다른 이름으로 저장"을 막으면 전체 저장이 실패한다. 이때는 시트 복사로 내려가고, 그것도 막히면
    `DRM_EXPORT_BLOCKED`로 끝낸다 — 값만 긁어 "원본 충실"인 척 보여주지 않는다.
- **성능**: 워크북 단위로 **한 번만** 연다(시트마다 열지 않는다). 해제본은 snapshot당 1회이므로 시트 전환·재검수는
  해제 비용을 다시 치르지 않는다.

### (C) 사용자 PC의 로컬 에이전트

```text
사용자 PC(DRM 클라이언트 + 권한) ── 에이전트 ──(업로드)──> 서버: 평문 또는 이미 해제된 사본
```

- **장점**: 권한 모델이 가장 단순하다 — 문서를 볼 권한이 있는 **사람**의 PC에서 해제하므로 서비스 계정에 복호화
  권한을 주는 협의가 필요 없다. 벤더 API도, 서버 Excel도 필요 없다.
- **단점·전제**: 배포·업데이트할 클라이언트가 하나 더 생긴다. 사용자가 PC를 켜 두지 않으면 자동 등록(`watch`,
  폴더 일괄 등록)이 돌지 않는다. 무엇보다 **해제본이 사용자 PC와 전송 구간에 존재**하므로 보안 검토가 가장 무겁다
  (임시 해제본 정책 §5의 6번).
- 이 경로를 고르면 서버는 평문만 받으므로 이 저장소 쪽에 추가 구현이 거의 없다(`local-xlsx` 경로 그대로).

### 고르는 순서

```text
벤더가 서버측 복호화 API를 준다 ──예──> (A)
        │아니오
        ▼
Windows 한 대를 상시 운용할 수 있다 ──예──> (B)
        │아니오
        ▼
(C) — 대신 임시 해제본 정책을 먼저 합의한다
```

---

## 4. 설정 방법

### 4.1 환경 변수 (`.env`, 접두는 `SCHEMA_` 하나뿐)

| 키 | 기본 | 뜻 |
|---|---|---|
| `SCHEMA_READER_FACTORY` | (없음) | `<모듈>:<함수>` 하나. 보안 읽기 어댑터 팩토리. **서버 설정에서만** 읽는다(요청 본문에서 받지 않는다) |
| `SCHEMA_READER_REVISION` | `unversioned-operator-adapter` | 어댑터 고정 버전(설정 화면·감사 표시용) |
| `SCHEMA_DRM_MAGIC` | (없음) | 보호 컨테이너 시그니처 목록. 쉼표로 나누고 항목마다 `hex:<16진>` · `ascii:<문자열>`(접두 없으면 ASCII), 항목당 32바이트 이하 |
| `SCHEMA_DRM_TEMP_DIR` | `<OS 임시>/schema-drm-<uid>` | 해제본 임시 폴더. **작업 공간 안을 가리키면 시작하지 않는다** |
| `SCHEMA_DRM_CACHE_TTL_SECONDS` | `900` | 마지막 사용 뒤 해제본을 남겨 두는 시간. `0`이면 재사용 없이 연산이 끝나는 즉시 삭제(보안 우선 배치) |
| `SCHEMA_DRM_CACHE_MB` | `2048` | 임시 폴더 총량 상한(넘으면 오래 안 쓴 것부터) |
| `SCHEMA_DRM_CACHE_MAX_SESSIONS` | `64` | 남겨 두는 세션 수 상한(넘으면 오래된 것부터) |
| `SCHEMA_DRM_OPEN_TIMEOUT_SECONDS` | `60` | 해제 한 건의 제한 시간. 초과하면 `DRM_OPEN_TIMEOUT` |
| `SCHEMA_DRM_COM_LOCK` | `<임시 폴더>/com.lock` | Excel COM 구간을 프로세스 간 동시 실행 1로 묶는 잠금 파일 |

### 4.2 어댑터 팩토리 계약

```python
# 예: myorg/reader.py
from pathlib import Path
from schema import drm
from schema.readers import XlsxReader


class VendorReader(XlsxReader):
    """권장 구현 — 해제본을 한 번 만들고 나머지 연산은 XlsxReader에 맡긴다."""

    def __init__(self, root, principal, provider):
        super().__init__(Path(root), principal)
        self.workspace, self.provider = Path(root), provider

    def authorize(self, source_ref, required="view"):
        # 벤더 정책 조회 → can_view / can_extract / can_render_web / can_cache_derivative / expires_at
        return {**super().authorize(source_ref, required), "provider": self.provider}

    def plain_path(self, source_ref, token):
        origin = self.path(source_ref)

        def unlock(destination):
            vendor_sdk.decrypt(origin, destination)  # 실패는 Problem('DRM_OPEN_FAILED'|'DRM_PERMISSION_DENIED'|…)

        return drm.SESSIONS.acquire(
            workspace=self.workspace, provider=self.provider,
            source_ref=source_ref, expected_token=token, unlock=unlock,
        ).path


def factory(*, root, provider, principal):
    return VendorReader(root, principal, provider)
```

```bash
SCHEMA_READER_FACTORY=myorg.reader:factory
```

`plain_path` 하나만 바꾸면 매치·추출·렌더·서명이 모두 기존 코드로 돈다. 오류는 `Problem(code, message, status)`로
올린다 — 계약이 아는 코드는 `DRM_READER_REQUIRED`(403) · `DRM_PERMISSION_DENIED`(403) · `DRM_OPEN_FAILED`(422) ·
`DRM_OPEN_TIMEOUT`(408) · `DRM_EXPORT_BLOCKED`(422) · `RENDER_UNSUPPORTED`(422)다. 그 밖의 예외는 격리 프로세스가
`READER_FAILED`로 덮어 경로·자격 증명을 응답에 노출하지 않는다.

### 4.3 Excel COM 참조 구현을 쓰는 경우 (Windows)

```bash
SCHEMA_READER_FACTORY=schema.drm:excel_com_reader
SCHEMA_READER_CONTEXT=spawn          # forkserver로 COM 상태를 물려받지 않게
SCHEMA_RENDER_CONCURRENCY=1
SCHEMA_DRM_OPEN_TIMEOUT_SECONDS=120  # 큰 워크북이면 늘린다
```

- **자동 로그온된 대화형 세션**에서 실행한다. 서비스·작업 스케줄러(서비스 계정)로 돌리지 않는다.
- 실행 계정이 그 문서를 Excel로 열 수 있어야 한다(DRM 클라이언트 설치 + 권한).
- Excel 인스턴스는 `DispatchEx`로 전용 생성하고 `Visible=False`·`DisplayAlerts=False`·읽기 전용으로 연다.
  끝나면 `Close(SaveChanges=False)` → `Quit()` → 남은 프로세스는 PID로 정리한다.

### 4.4 점검

```bash
python -m schema drm-probe --ws <ws>                    # 파일을 열지 않고 판별만
python -m schema drm-probe --ws <ws> --unlock --json    # 보호 문서마다 실제 해제 1회 + 소요 ms
python -m schema drm-probe --ws <ws> --source 보고서.xlsx --unlock
```

- 출력에 **원본 내용·셀 값·시트 이름·자격 증명·해제본 경로가 없다**(시트는 개수만).
- `--unlock`은 잰 뒤 그 자리에서 세션 파일을 지운다(캐시에 남기지 않는다).
- 종료 코드: `0` 전부 읽을 수 있음 · `1` 해제 실패 · `2` 어댑터 설정 없음.

화면에서는 `설정 > Reader` 카드가 같은 값을 보여 준다(연결 상태·어댑터 버전·임시 폴더·해제 캐시 유지·등록된 시그니처 수).

---

## 5. DRM 운영 담당자에게 물어야 할 것 (체크리스트)

아래는 **확인되지 않은 항목**이다. 답에 따라 §3의 경로가 정해진다. 그대로 복사해 쓰면 된다.

1. **제품과 버전** — 어떤 DRM/보안 문서 제품인가, 서버·클라이언트 버전은? 문서에 붙는 컨테이너의
   **앞 몇 바이트가 고정 시그니처**인가(`SCHEMA_DRM_MAGIC`에 넣을 값)? 확장자는 원본 그대로 유지되는가?
2. **서버측 복호화 API/SDK** — 서버에서 호출할 수 있는 복호화 API 또는 SDK를 제공하는가?
   (a) 프로토콜(REST/로컬 라이브러리), (b) 지원 OS(리눅스 가능 여부), (c) 라이선스 비용·수량 제한.
3. **서비스 계정 권한** — 사람 계정이 아니라 **등록 시스템(서비스 계정)**에 복호화 권한을 줄 수 있는가?
   권한이 사용자 로그인 세션(대화형 토큰)에 묶여 있는가? 무인 서버에서 동작하는가?
4. **등록 시스템 방식 지원** — 문서를 열람하는 것이 아니라 **기계가 일괄로 읽어 데이터로 만드는 용도**를
   정책상 허용하는가? 별도 승인·계약이 필요한가? 대상 폴더·문서 종류를 한정해야 하는가?
5. **감사 로그 요구사항** — 접근 기록에 반드시 남겨야 하는 항목은 무엇인가(누가·언제·무엇을·어떤 목적).
   보존 기간은? 벤더 서버에 이미 남는가, 우리 쪽에도 남겨야 하는가? 형식·전송 방식 요구가 있는가?
   (지금 이 시스템은 `<ws>/data/audit/drm-<YYYYMMDD>.jsonl`에 남기고 해제본 경로·내용은 남기지 않는다.)
6. **임시 해제본 정책** — 평문 해제본을 디스크에 만드는 것이 허용되는가?
   (a) 허용된다면 위치·권한·보존 시간 요구(`SCHEMA_DRM_CACHE_TTL_SECONDS`를 얼마로 둘 것인가, `0`이어야 하는가),
   (b) 허용되지 않는다면 메모리 전용만 가능한가(그 경우 `can_cache_derivative=false` + TTL 0으로 운용한다),
   (c) 해제본을 만든 사실 자체를 보고해야 하는가.
7. **Windows COM 경로를 쓸 경우** — 자동 로그온된 대화형 세션에서 Excel을 계속 띄워 두는 운용이 보안 정책상
   허용되는가? 그 계정에 어떤 문서 범위의 권한을 줄 것인가?
8. **권한 철회** — 사용자·문서의 권한이 철회되면 이미 추출한 값과 렌더 캐시는 어떻게 다뤄야 하는가?
   (이 시스템은 `authorize`를 연산 시작과 끝에 다시 확인하고, 철회는 `DRM_PERMISSION_DENIED`로 올라온다.)

---

## 6. 남은 일

- 벤더 어댑터 구현(§3 A/B/C 중 선택) — 이 저장소 밖 운영자 패키지.
- `SCHEMA_DRM_MAGIC`의 실제 값 확보 후 `.env.sample` 주석에 예시 추가.
- Windows 한 대에서 `drm-probe --unlock` 실측(해제 ms, 실패 모드) → §2의 "5초"를 측정값으로 교체.
- 권한 철회·만료가 있는 실제 제공자에서 `authorize` 재확인 동작 검증.
