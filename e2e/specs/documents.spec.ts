// 문서 화면 E2E(계약 §8 documents.spec): 쉘·표·필터·정렬 → 등록 대화상자·상세 드로어·잠긴 문서 → 새 snapshot·데이터 빌드 인계
// → 문서 삭제(§4.13: 다중·단건·원본 파일·대표 문서 프로파일 초안·작업 내역·거부).
// 여섯 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false). 1번은 시드 6건을 그대로 보고, 2번이 7번째 문서를 등록하며,
// 3번이 대표 문서를 바꿔 새 snapshot을 만들고, 4~6번이 되돌릴 수 없는 삭제를 마지막에 돌린다(지운 문서는 다음 스펙 파일의
// resetWorkspace()가 새 작업 공간을 시드하므로 남지 않는다). 모든 단언은 실제 표시 문구(한국어 라벨·셀 텍스트)를 본다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DRM_MESSAGE, api, collectErrors, copyRawDocument, mutateFirstDocument, openDocument, openScreen, rawFileExists, registerViaApi, resetWorkspace, waitForJobs } from "./helpers";

const REFERENCE = "공정데이터_2024_01.xlsx";
const IDENTICAL = ["공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"];
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const OTHER = "품질검사_2024_05.xlsx";
const LOCKED = "공정데이터_2024_06_잠김.xlsx";
const NEW_COPY = "공정데이터_2024_07.xlsx";
const PROFILE_V1 = "공정데이터_A양식 v1";
const SCHEMA_NAME = "공정 데이터 표준";
const STATUS_LABELS = ["정상", "검수 필요", "변경 감지", "프로파일 없음", "재추출 필요", "파싱 실패", "잠김(DRM)"];

const documentsTable = (page: Page) => page.getByRole("table", { name: "문서 목록" });
const rowOf = (page: Page, name: string) => documentsTable(page).getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
const statusChip = (page: Page, name: string) => rowOf(page, name).getByRole("cell").nth(2).locator(".app-chip");
const filters = (page: Page) => page.getByRole("search", { name: "문서 필터" });

async function gotoDocuments(page: Page) {
  await page.goto("/?screen=documents");
  await expect(documentsTable(page)).toBeVisible();
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("쉘 · 문서 표 · 상태 칩 · 필터 · 정렬", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page).toHaveTitle("Semantic Excel Integration");
  await expect(page.locator(".app-brand strong")).toHaveText("Semantic Excel Integration");
  await expect(page.locator(".app-brand small")).toHaveText("Document-to-Table Adapter");
  const nav = page.getByRole("navigation", { name: "주 메뉴" });
  await expect(nav.getByRole("button")).toHaveText(["문서", "파싱 프로파일", "파싱 스키마", "데이터 빌드", "작업 내역"]);
  await expect(page.getByRole("navigation", { name: "보조 메뉴" }).getByRole("button")).toHaveText(["설정"]);
  await expect(nav.getByRole("button", { name: "문서", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("button", { name: "파싱 프로파일" })).not.toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "문서" })).toBeVisible();

  // 시드 6건과 상태 칩·적용 프로파일·연결 스키마.
  const table = documentsTable(page);
  await expect(table.getByRole("row")).toHaveCount(7); // 헤더 + 6
  await expect(filters(page).getByRole("status")).toHaveText("6건 표시 · 1 페이지");
  for (const name of [REFERENCE, ...IDENTICAL]) {
    await expect(statusChip(page, name)).toHaveText("정상");
    await expect(statusChip(page, name)).toHaveClass(/\bok\b/);
    await expect(rowOf(page, name).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
    await expect(rowOf(page, name).getByRole("cell").nth(4)).toHaveText(SCHEMA_NAME);
    await expect(rowOf(page, name).getByRole("cell").nth(5)).toContainText("최신");
  }
  await expect(statusChip(page, SHIFTED)).toHaveText("검수 필요");
  await expect(statusChip(page, SHIFTED)).toHaveClass(/\bwarn\b/);
  await expect(rowOf(page, SHIFTED).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  await expect(statusChip(page, OTHER)).toHaveText("프로파일 없음");
  await expect(rowOf(page, OTHER).getByRole("cell").nth(3)).toHaveText("-");
  await expect(rowOf(page, OTHER).getByRole("cell").nth(4)).toHaveText("-");
  await expect(statusChip(page, LOCKED)).toHaveText("잠김(DRM)");
  await expect(statusChip(page, LOCKED)).toHaveClass(/\berr\b/);
  await expect(statusChip(page, LOCKED)).toHaveAttribute("title", DRM_MESSAGE);
  await expect(rowOf(page, LOCKED).getByRole("cell").nth(5)).toHaveText("없음");
  // 화면 텍스트에 내부 ID(UUID·SHA-256)가 없다(§7 표시 규칙).
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  expect(body).not.toMatch(/[0-9a-f]{64}/i);

  // 상태 필터: 7개 라벨 전부, 검수 필요 → 양식이동 문서 1건.
  const statusSelect = filters(page).getByLabel("상태");
  await expect(statusSelect.locator("option")).toHaveText(["전체", ...STATUS_LABELS]);
  await statusSelect.selectOption("review");
  await expect(page).toHaveURL(/status=review/);
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, SHIFTED)).toBeVisible();
  await expect(filters(page).getByRole("status")).toHaveText("1건 표시 · 1 페이지");
  await statusSelect.selectOption("locked");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, LOCKED)).toBeVisible();
  await statusSelect.selectOption("failed");
  await expect(page.getByText("조건에 맞는 문서가 없습니다.")).toBeVisible();
  await expect(table).toHaveCount(0);
  await filters(page).getByRole("button", { name: "필터 해제" }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(table.getByRole("row")).toHaveCount(7);

  // 프로파일 필터: 프로파일이 적용된 문서 4건.
  const profileSelect = filters(page).getByLabel("파싱 프로파일");
  await expect(profileSelect.locator("option")).toHaveText(["전체", PROFILE_V1]);
  await profileSelect.selectOption({ label: PROFILE_V1 });
  await expect(page).toHaveURL(/profile_id=/);
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(rowOf(page, OTHER)).toHaveCount(0);
  await expect(rowOf(page, LOCKED)).toHaveCount(0);
  await filters(page).getByRole("button", { name: "필터 해제" }).click();
  await expect(table.getByRole("row")).toHaveCount(7);

  // 검색(250ms 디바운스): 품질 → 1건, 지우면 6건.
  const search = filters(page).getByLabel("문서 검색");
  await search.fill("품질");
  await expect(table.getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, OTHER)).toBeVisible();
  await search.fill("없는문서");
  await expect(page.getByText("조건에 맞는 문서가 없습니다.")).toBeVisible();
  await search.fill("");
  await expect(table.getByRole("row")).toHaveCount(7);

  // 정렬 헤더: 기본 -last_processed_at(최근 처리 내림차순), 문서명은 첫 클릭 오름차순 → 재클릭 내림차순.
  const nameHeader = page.getByRole("columnheader", { name: "문서명" });
  const processedHeader = page.getByRole("columnheader", { name: "최근 처리" });
  await expect(processedHeader).toHaveAttribute("aria-sort", "descending");
  await expect(nameHeader).toHaveAttribute("aria-sort", "none");
  await nameHeader.getByRole("button").click();
  await expect(page).toHaveURL(/sort=document_name/);
  await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
  await expect(processedHeader).toHaveAttribute("aria-sort", "none");
  const ascending = await table.locator("tbody tr td:nth-child(2)").allInnerTexts();
  expect(ascending).toEqual([REFERENCE, ...IDENTICAL, SHIFTED, LOCKED, OTHER]);
  await nameHeader.getByRole("button").click();
  await expect(page).toHaveURL(/sort=-document_name/);
  await expect(nameHeader).toHaveAttribute("aria-sort", "descending");
  const descending = await table.locator("tbody tr td:nth-child(2)").allInnerTexts();
  expect(descending).toEqual([...ascending].reverse());
  await page.getByRole("columnheader", { name: "상태" }).getByRole("button").click();
  await expect(page.getByRole("columnheader", { name: "상태" })).toHaveAttribute("aria-sort", "ascending");
  await expect(nameHeader).toHaveAttribute("aria-sort", "none");

  // 다른 화면으로 갔다가 돌아와도 aria-current가 따라온다.
  await openScreen(page, "설정");
  await expect(nav.getByRole("button", { name: "문서", exact: true })).not.toHaveAttribute("aria-current", "page");
  // 설정은 읽기 전용이다: 사용자 접근 토큰 카드는 없고(메인 API는 인증하지 않는다), Reader 카드가 무엇을 설정해야 하는지 알려 준다.
  await expect(page.getByRole("region", { name: "서버 접근" })).toHaveCount(0);
  await expect(page.getByLabel("접근 토큰")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
  const reader = page.getByRole("region", { name: "Reader" });
  await expect(reader).toBeVisible();
  await expect(reader).toContainText("보호된 문서를 읽으려면 서버에 SCHEMA_READER_FACTORY를 설정하고 python -m schema drm-probe로 확인하세요.");
  await expect(reader).toContainText("이 서버는 기본으로 127.0.0.1에만 열립니다.");
  // 계약 §7: 칩 문구는 `연결됨`/`연결 안 됨`이다.
  await expect(reader.locator(".app-chip").first()).toHaveText("연결 안 됨");
  await expect(reader).toContainText("등록된 보호 문서 시그니처");
  const settingsApi = await api(page, "GET", "/settings");
  expect(settingsApi.status).toBe(200);
  expect(settingsApi.json).not.toHaveProperty("access_token_required");
  expect(settingsApi.json.reader).toMatchObject({ drm: { available: false } });
  await openScreen(page, "문서");
  await expect(page).toHaveURL(/screen=documents/);
  errors.assertClean();
});

test("문서 등록 대화상자 · 상세 드로어(파일 보기·추출 결과·적용 프로파일·연결 스키마) · 잠긴 문서", async ({ page }) => {
  const errors = collectErrors(page);
  // 같은 양식 파일을 원본 폴더에 복사해 두고 대화상자에서 고른다.
  copyRawDocument(IDENTICAL[0], NEW_COPY);
  await gotoDocuments(page);
  await page.getByRole("button", { name: "+ 문서 등록" }).click();
  const register = page.getByRole("dialog", { name: "문서 등록" });
  await expect(register).toBeVisible();
  await expect(register.getByRole("heading", { name: "문서 등록" })).toBeVisible();
  const sources = register.getByRole("table", { name: "원본 파일 목록" });
  await expect(sources.getByRole("row")).toHaveCount(8); // 헤더 + 시드 6 + 복사본 1
  await expect(register.getByRole("button", { name: "문서 등록", exact: true })).toBeDisabled();
  await register.getByRole("checkbox", { name: NEW_COPY, exact: true }).check();
  await expect(register.getByText("1개 선택")).toBeVisible();
  await expect(register.getByLabel("선택한 파일").getByRole("button", { name: `${NEW_COPY} 선택 해제` })).toBeVisible();
  await register.getByRole("button", { name: "1개 문서 등록" }).click();
  const results = register.getByRole("table", { name: "등록 결과" });
  await expect(results).toBeVisible();
  const resultRow = results.getByRole("row").filter({ hasText: NEW_COPY });
  await expect(resultRow.getByRole("cell").nth(1)).toHaveText("완료");
  await expect(resultRow.getByRole("cell").nth(2)).toHaveText("공정데이터_A양식 · 동일");
  await expect(resultRow.getByRole("cell").nth(3)).toHaveText("정상");
  await expect(resultRow.getByRole("cell").nth(4)).toHaveText("");
  await expect(register.getByText("1개 중 1개 등록 · 0개 실패")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "1개 문서를 등록했습니다." })).toBeVisible();
  // 대화상자에는 × (aria-label 닫기)와 주 행동 닫기 두 개가 있다.
  await register.locator("button.primary", { hasText: "닫기" }).click();
  await expect(register).toHaveCount(0);
  await expect(documentsTable(page).getByRole("row")).toHaveCount(8);
  await expect(statusChip(page, NEW_COPY)).toHaveText("정상");
  await expect(rowOf(page, NEW_COPY).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  await expect(rowOf(page, NEW_COPY).getByRole("cell").nth(4)).toHaveText(SCHEMA_NAME);
  const registered = await api(page, "GET", "/documents?q=" + encodeURIComponent(NEW_COPY));
  expect(registered.json.items).toHaveLength(1);
  expect(registered.json.items[0].profiles[0]).toMatchObject({ profile_name: "공정데이터_A양식", rev: 1, state: "published", compatibility: "identical" });
  await waitForJobs(page);

  // 상세 드로어(대표 문서).
  const detail = await openDocument(page, REFERENCE);
  await expect(page).toHaveURL(/document=/);
  await expect(detail).toHaveAttribute("aria-modal", "true");
  const head = detail.locator(".app-modal-head");
  await expect(head.locator(".app-chip").first()).toHaveText("정상");
  await expect(head).toContainText(/현재 Snapshot \d{4}-\d{2}-\d{2}/);
  await expect(head.getByText("최신", { exact: true })).toBeVisible();
  const relation = detail.locator('[aria-label="문서 관계"]');
  await expect(relation.locator("small")).toHaveText(["문서", "파싱 프로파일", "파싱 스키마"]);
  await expect(relation.locator("strong")).toHaveText([REFERENCE, PROFILE_V1, SCHEMA_NAME]);
  await expect(relation.locator(".arrow")).toHaveCount(2);
  await expect(detail.getByText("Snapshot 이력 · 현재 r1")).toBeVisible();
  await expect(detail.getByRole("button", { name: "원본 보기" }).first()).toBeEnabled();
  await expect(detail.getByRole("button", { name: "다른 프로파일로 파싱" })).toBeEnabled();
  const tabs = detail.getByRole("tablist", { name: "문서 상세 탭" });
  await expect(tabs.getByRole("tab")).toHaveText(["파일 보기", "추출 결과", "적용 프로파일", "연결 스키마"]);
  await expect(tabs.getByRole("tab", { name: "파일 보기" })).toHaveAttribute("aria-selected", "true");

  // 파일 보기: 시트 목록 + SheetViewer(실제 셀). 첫 요청은 202(렌더링 중) 폴링을 거쳐 셀이 그려진다.
  const sheetList = detail.locator(".app-side-list");
  await expect(sheetList.getByRole("button")).toHaveCount(2);
  await expect(sheetList.getByRole("button").nth(0)).toContainText("공정 기록");
  await expect(sheetList.getByRole("button").nth(0)).toContainText("20행 · 7열");
  await expect(sheetList.getByRole("button").nth(0)).toHaveAttribute("aria-current", "true");
  await expect(sheetList.getByRole("button").nth(1)).toContainText("공통 정보");
  const viewer = detail.locator(".app-viewer");
  const cell = (ref: string) => viewer.locator(`.app-cell[data-ref="${ref}"]`);
  await expect(cell("C8")).toHaveText("온도", { timeout: 60_000 });
  await expect(cell("C8")).toHaveAttribute("aria-label", "C8 온도");
  await expect(cell("C8")).toHaveClass(/\bbold\b/);
  await expect(cell("C9")).toHaveText("150");
  await expect(cell("C10")).toHaveText("152.5");
  await expect(cell("A9")).toHaveText("LOT-01-001");
  await expect(cell("G9")).toHaveText("불합격");
  await expect(cell("A1")).toHaveText("공정 데이터 기록 · 검증용 가상 데이터");
  await expect(cell("A1")).toHaveAttribute("data-range", "A1:G1");
  await expect(cell("A1")).toHaveClass(/\bmerged\b/);
  // 툴바의 행×열은 시트 추정 크기가 아니라 캐시된 렌더 범위(A1:Z60 창)다.
  await expect(viewer.locator(".app-viewer-toolbar")).toContainText("공정 기록 · 60행 × 26열");
  await expect(viewer.getByText("렌더링 중")).toHaveCount(0);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  const cellCount = await viewer.locator(".app-cell").count();
  expect(cellCount).toBeGreaterThan(0);
  expect(cellCount).toBeLessThanOrEqual(3000);
  // 셀 이동(A1 형식) → 초점 셀.
  await viewer.getByLabel("셀 이동").fill("C9");
  await viewer.getByRole("button", { name: "이동" }).click();
  await expect(cell("C9")).toHaveClass(/\bfocused\b/);
  // 확대 50~150%.
  const zoom = detail.getByRole("group", { name: "확대" });
  await expect(zoom).toContainText("100%");
  await zoom.getByRole("button", { name: "축소" }).click();
  await expect(zoom).toContainText("90%");
  await expect(viewer.locator(".app-sheet")).toHaveCSS("transform", /matrix\(0\.9, 0, 0, 0\.9, 0, 0\)/);
  await zoom.getByRole("button", { name: "확대" }).click();
  await expect(zoom).toContainText("100%");
  // 다른 시트로 갔다가 같은 시트를 다시 열면 캐시된 창이 즉시(200) 온다 — 렌더링 중 상태 없이 셀이 보인다.
  await sheetList.getByRole("button", { name: /공통 정보/ }).click();
  await expect(page).toHaveURL(/sheet=/);
  await expect(cell("A1")).toHaveText("온도 단위", { timeout: 60_000 });
  await expect(cell("B1")).toHaveText("°C");
  await expect(cell("B3")).toHaveText("min");
  await sheetList.getByRole("button", { name: /공정 기록/ }).click();
  await expect(cell("C8")).toHaveText("온도");
  await expect(viewer.getByText("렌더링 중")).toHaveCount(0);
  const docDetail = await api(page, "GET", "/documents/" + new URL(page.url()).searchParams.get("document"));
  const snapshotId = docDetail.json.current_snapshot.snapshot_id as string;
  const sheets = await api(page, "GET", `/snapshots/${snapshotId}/sheets`);
  const mainSheet = sheets.json.items.find((s: { sheet_name: string }) => s.sheet_name === "공정 기록");
  const cached = await page.request.get(`/api/snapshots/${snapshotId}/sheets/${mainSheet.sheet_id}/render?range=A1:Z60`);
  expect(cached.status()).toBe(200);
  expect(cached.headers()["etag"]).toBeTruthy();
  const window = await cached.json();
  expect(window.cells.some((c: { text: string; r1: number; c1: number }) => c.text === "온도" && c.r1 === 8 && c.c1 === 3)).toBe(true);
  const notModified = await page.request.get(`/api/snapshots/${snapshotId}/sheets/${mainSheet.sheet_id}/render?range=A1:Z60`, {
    headers: { "If-None-Match": cached.headers()["etag"] },
  });
  expect(notModified.status()).toBe(304);

  // 추출 결과: 필드·파싱 규칙·값·단위·원본 위치, 규칙 필터, 원본 보기 → ?review=&rule=&sheet=&range=.
  await tabs.getByRole("tab", { name: "추출 결과" }).click();
  await expect(page).toHaveURL(/tab=values/);
  const values = detail.getByRole("table", { name: "추출 결과" });
  await expect(values.getByRole("columnheader")).toHaveText(["필드", "파싱 규칙", "값", "단위", "원본 위치", "행동"]);
  await expect(values.locator("tbody tr")).toHaveCount(50);
  await expect(detail.getByRole("button", { name: "다음", exact: true })).toBeEnabled();
  // 규칙 필터의 목록은 지금까지 읽은 행(첫 50건: duration·equipment·lot·measured_at·pressure·process_name)에서만 채워진다 —
  // 뒤 페이지에만 있는 규칙(온도 등)은 다음 페이지를 읽기 전에는 고를 수 없다(UI 한계, 보고서에 기록).
  const unfilteredFirst = values.locator("tbody tr").first();
  await expect(unfilteredFirst.getByRole("cell").nth(0)).toHaveText("시간 · r9");
  await expect(unfilteredFirst.getByRole("cell").nth(2)).toHaveText("30");
  await expect(unfilteredFirst.getByRole("cell").nth(3)).toHaveText("min");
  await expect(unfilteredFirst.getByRole("cell").nth(4)).toHaveText("공정 기록!E9");
  const ruleSelect = detail.getByLabel("파싱 규칙");
  await expect(ruleSelect.locator("option")).toHaveText(["전체", "시간", "설비명", "배치", "측정일시", "압력", "공정명"]);
  await ruleSelect.selectOption({ label: "압력" });
  await expect(values.locator("tbody tr")).toHaveCount(12);
  const first = values.locator("tbody tr").first();
  await expect(first.getByRole("cell").nth(0)).toHaveText("압력 · r9");
  await expect(first.getByRole("cell").nth(1)).toHaveText("압력");
  await expect(first.getByRole("cell").nth(2)).toHaveText("1.2");
  await expect(first.getByRole("cell").nth(3)).toHaveText("bar");
  await expect(first.getByRole("cell").nth(4)).toHaveText("공정 기록!D9");
  await expect(values.locator("tbody tr").nth(1).getByRole("cell").nth(2)).toHaveText("1.25");
  await expect(values.locator("tbody tr").nth(1).getByRole("cell").nth(4)).toHaveText("공정 기록!D10");
  const detailText = await detail.innerText();
  expect(detailText).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  await first.getByRole("button", { name: "원본 보기" }).click();
  await expect(page).toHaveURL(/review=[0-9a-f-]{36}/);
  await expect(page).toHaveURL(/rule=pressure/);
  await expect(page).toHaveURL(new RegExp(`sheet=${mainSheet.sheet_id}`));
  await expect(page).toHaveURL(/range=D9/);
  const applicationId = new URL(page.url()).searchParams.get("review")!;
  expect(applicationId).toBe(docDetail.json.profiles[0].application_id);
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(review.locator(`.app-cell[data-ref="D9"]`)).toHaveText("1.2", { timeout: 60_000 });
  await expect(review.locator("strong").first()).toHaveText(REFERENCE);
  await expect(review).toContainText("/ 공정 기록");
  await expect(review).toContainText(`/ ${PROFILE_V1}`);
  await expect(review).toContainText(`/ ${SCHEMA_NAME}`);
  await expect(review.getByRole("group", { name: "파싱 규칙 목록" }).getByRole("button", { name: /^압력 / })).toBeVisible();
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  await expect(detail).toBeVisible();
  await expect(page).toHaveURL(/tab=values/);

  // 적용 프로파일: 프로파일 v1 · 상태(발행) · 호환 · 검수 11/11 · 발행 칩 · 행동.
  await tabs.getByRole("tab", { name: "적용 프로파일" }).click();
  const applications = detail.getByRole("table", { name: "적용 프로파일" });
  await expect(applications.getByRole("columnheader")).toHaveText(["프로파일", "상태", "호환", "검수", "발행", "행동"]);
  const appRow = applications.locator("tbody tr");
  await expect(appRow).toHaveCount(1);
  await expect(appRow.getByRole("cell").nth(0)).toHaveText(PROFILE_V1);
  await expect(appRow.getByRole("cell").nth(1)).toHaveText("발행");
  // 대표 문서는 시드에서 수동 적용(compatibility=manual)됐다. 동일(identical)은 자동 적용된 02·03·07 문서다.
  await expect(appRow.getByRole("cell").nth(2)).toHaveText("수동");
  await expect(appRow.getByRole("cell").nth(3)).toHaveText("11/11");
  await expect(appRow.getByRole("cell").nth(4)).toHaveText("발행");
  await expect(appRow.getByRole("button", { name: "원본 보기" })).toBeVisible();
  await expect(appRow.getByRole("button", { name: "프로파일 열기" })).toBeVisible();

  // 연결 스키마 카드.
  await tabs.getByRole("tab", { name: "연결 스키마" }).click();
  const schemaCard = detail.locator(".app-list-item").filter({ hasText: SCHEMA_NAME });
  await expect(schemaCard).toHaveCount(1);
  await expect(schemaCard.locator("strong")).toHaveText(SCHEMA_NAME);
  await expect(schemaCard.locator("small")).toHaveText(`프로파일 ${PROFILE_V1} 경유 · 파싱 스키마 화면에서 구조 보기 ›`);

  // Escape → 닫힘, ?document= 제거, 표는 그대로.
  await detail.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page).not.toHaveURL(/document=/);
  await expect(page).not.toHaveURL(/tab=/);
  await expect(documentsTable(page)).toBeVisible();

  // 잠긴 문서: 잠김 칩, 드로어의 최근 오류(DRM), 파일 보기는 Snapshot 없음 안내만. 페이지는 계속 쓸 수 있다.
  const locked = await openDocument(page, LOCKED);
  await expect(locked.locator(".app-modal-head .app-chip").first()).toHaveText("잠김(DRM)");
  await expect(locked.locator(".app-modal-head")).toContainText("Snapshot 없음");
  await expect(locked.getByRole("alert")).toHaveText("최근 오류: " + DRM_MESSAGE);
  await expect(locked.locator('[aria-label="문서 관계"] strong')).toHaveText([LOCKED, "없음", "없음"]);
  await expect(locked.getByRole("tab", { name: "파일 보기" })).toHaveAttribute("aria-selected", "true");
  await expect(locked.getByText("현재 Snapshot이 없어 파일을 보여줄 수 없습니다.")).toBeVisible();
  await expect(locked.locator(".app-viewer")).toHaveCount(0);
  await expect(locked.getByRole("button", { name: "원본 보기" })).toBeDisabled();
  await expect(locked.getByRole("button", { name: "다른 프로파일로 파싱" })).toBeDisabled();
  await expect(locked.getByRole("button", { name: "데이터 빌드에 추가" })).toBeEnabled();
  await locked.getByRole("tab", { name: "추출 결과" }).click();
  await expect(locked.getByText("현재 Snapshot이 없습니다.")).toBeVisible();
  await locked.getByRole("tab", { name: "적용 프로파일" }).click();
  await expect(locked.getByText("적용된 파싱 프로파일이 없습니다. 맞는 프로파일을 골라 직접 파싱할 수 있습니다.")).toBeVisible();
  const lockedDetail = await api(page, "GET", "/documents/" + new URL(page.url()).searchParams.get("document"));
  expect(lockedDetail.json).toMatchObject({ status: "locked", current_snapshot: null, last_error: DRM_MESSAGE, status_detail: { locked: { code: "DRM_READER_REQUIRED" } } });
  await locked.getByRole("button", { name: "닫기", exact: true }).click();
  await expect(locked).toHaveCount(0);
  await filters(page).getByLabel("문서 검색").fill("");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(8);
  await page.getByRole("columnheader", { name: "문서명" }).getByRole("button").click();
  await expect(page.getByRole("columnheader", { name: "문서명" })).toHaveAttribute("aria-sort", "ascending");
  errors.assertClean();
});

test("새 snapshot(변경 감지) · Snapshot 이력 · 다중 선택 → 데이터 빌드", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoDocuments(page);
  const before = await api(page, "GET", "/documents?q=" + encodeURIComponent(REFERENCE));
  const documentId = before.json.items[0].document_id as string;
  const firstSnapshot = before.json.items[0].current_snapshot.snapshot_id as string;
  expect(before.json.items[0].current_snapshot.revision_no).toBe(1);

  // 대표 문서의 값을 바꾸고 같은 이름으로 다시 등록 → r2 snapshot, application은 inherited(변경 감지).
  expect(mutateFirstDocument()).toBe(REFERENCE);
  const job = await registerViaApi(page, [REFERENCE]);
  expect(job.kind).toBe("register");
  expect(job.label).toBe(REFERENCE);
  const registered = job.result.documents[0];
  expect(registered).toMatchObject({ document_id: documentId, document_name: REFERENCE, status: "changed" });
  expect(registered.snapshot).toMatchObject({ revision_no: 2, unchanged: false });
  expect(registered.snapshot.snapshot_id).not.toBe(firstSnapshot);
  expect(registered.applied).toHaveLength(1);
  expect(registered.applied[0]).toMatchObject({ profile_name: "공정데이터_A양식", compatibility: "identical", state: "changed" });
  await waitForJobs(page);

  await page.reload();
  await expect(documentsTable(page)).toBeVisible();
  await expect(statusChip(page, REFERENCE)).toHaveText("변경 감지");
  await expect(statusChip(page, REFERENCE)).toHaveClass(/\bwarn\b/);
  await expect(rowOf(page, REFERENCE).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  await expect(rowOf(page, REFERENCE).getByRole("cell").nth(5)).toContainText("최신");
  await expect(rowOf(page, REFERENCE).getByRole("cell").nth(6)).toHaveText(/방금 전|\d+분 전/);
  // 변경 감지 문서는 검수 필요 필터가 아니라 변경 감지 필터에서만 보인다.
  await filters(page).getByLabel("상태").selectOption("changed");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(2);
  await expect(rowOf(page, REFERENCE)).toBeVisible();
  await filters(page).getByRole("button", { name: "필터 해제" }).click();

  const detail = await openDocument(page, REFERENCE);
  await expect(detail.locator(".app-modal-head .app-chip").first()).toHaveText("변경 감지");
  await expect(detail.locator(".app-modal-head")).toContainText("최신");
  await expect(detail.locator('[aria-label="문서 관계"]')).toContainText("최근 처리");
  const history = detail.locator("details.app-details");
  await expect(history.locator("summary")).toHaveText("Snapshot 이력 · 현재 r2");
  await history.locator("summary").click();
  const entries = detail.getByRole("list", { name: "Snapshot 목록" }).getByRole("listitem");
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText(/^r2 · \d{4}-\d{2}-\d{2}/);
  await expect(entries.nth(0).locator(".app-chip")).toHaveText("최신");
  await expect(entries.nth(1)).toContainText(/^r1 · \d{4}-\d{2}-\d{2}/);
  await expect(entries.nth(1).locator(".app-chip")).toHaveCount(0);

  // 추출 결과 탭은 현재(r2) snapshot만 본다. inherited application은 아직 추출·발행되지 않았으므로 빈 상태이며,
  // 이전 r1의 발행 값은 UI에서는 보이지 않고 API(GET /snapshots/{r1}/values)로만 남아 있다.
  await detail.getByRole("tab", { name: "추출 결과" }).click();
  await expect(detail.getByText("추출된 값이 없습니다. 적용 프로파일 탭에서 파싱을 실행하세요.")).toBeVisible();
  await expect(detail.getByRole("table", { name: "추출 결과" })).toHaveCount(0);
  const newValues = await api(page, "GET", `/snapshots/${registered.snapshot.snapshot_id}/values`);
  expect(newValues.json.items).toEqual([]);
  const oldValues = await api(page, "GET", `/snapshots/${firstSnapshot}/values?rule_key=temperature`);
  expect(oldValues.json.items).toHaveLength(12);
  expect(oldValues.json.items[0]).toMatchObject({ value_text: "150", unit_normalized: "°C", first_region: { sheet_name: "공정 기록", range: "C9" } });
  const snapshots = await api(page, "GET", `/documents/${documentId}/snapshots`);
  expect(snapshots.json.items.map((s: { revision_no: number; current: boolean; application_count: number }) => [s.revision_no, s.current, s.application_count])).toEqual([
    [2, true, 1],
    [1, false, 1],
  ]);

  // 적용 프로파일: 상태 변경 감지 · 호환 동일 · 검수 0/11 · 미발행.
  await detail.getByRole("tab", { name: "적용 프로파일" }).click();
  const appRow = detail.getByRole("table", { name: "적용 프로파일" }).locator("tbody tr");
  await expect(appRow).toHaveCount(1);
  await expect(appRow.getByRole("cell").nth(0)).toHaveText(PROFILE_V1);
  await expect(appRow.getByRole("cell").nth(1)).toHaveText("변경 감지");
  await expect(appRow.getByRole("cell").nth(2)).toHaveText("동일");
  await expect(appRow.getByRole("cell").nth(3)).toHaveText("0/11");
  await expect(appRow.getByRole("cell").nth(4)).toHaveText("미발행");
  // 파일 보기는 새 snapshot의 바뀐 값(온도 +0.5, 레시피 개정)을 그린다.
  await detail.getByRole("tab", { name: "파일 보기" }).click();
  const cell = (ref: string) => detail.locator(`.app-viewer .app-cell[data-ref="${ref}"]`);
  await expect(cell("C9")).toHaveText("150.5", { timeout: 60_000 });
  await expect(cell("B4")).toHaveText("RCP-101-개정");
  await detail.press("Escape");
  await expect(detail).toHaveCount(0);

  // 다중 선택 2건 → 데이터 빌드에 추가 → 토스트 → 데이터 빌드 1단계 '입력 문서 2개'. (openDocument가 채운 검색어를 먼저 지운다.)
  await filters(page).getByLabel("문서 검색").fill("");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(8);
  await page.getByRole("checkbox", { name: `${IDENTICAL[0]} 선택` }).check();
  await page.getByRole("checkbox", { name: `${IDENTICAL[1]} 선택` }).check();
  const selection = page.getByRole("region", { name: "선택한 문서" });
  await expect(selection).toContainText("2개 선택");
  await expect(rowOf(page, IDENTICAL[0])).toHaveClass(/\bselected\b/);
  await selection.getByRole("button", { name: "데이터 빌드에 추가" }).click();
  const toast = page.locator(".app-toast").filter({ hasText: "2개 문서 · 데이터 빌드로 이동 ›" });
  await expect(toast).toBeVisible();
  await expect(selection).toHaveCount(0);
  await toast.getByRole("button", { name: "데이터 빌드로 이동" }).click();
  await expect(page).toHaveURL(/screen=build/);
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "데이터 빌드" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서 2개/ })).toHaveText("입력 문서 2개 · 사용 가능 2개 · 제외 0개");
  const targets = page.getByRole("table", { name: "대상 문서" });
  await expect(targets.locator("tbody tr")).toHaveCount(2);
  for (const name of IDENTICAL) {
    const row = targets.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("cell").nth(1)).toHaveText("사용 가능");
    await expect(row.getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  }
  await expect(page.getByRole("button", { name: "다음: 스키마" })).toBeEnabled();
  // 인계는 sessionStorage 초안으로만 이루어진다(URL에 ID 없음).
  expect(page.url()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem("schema.build.draft") || "null"));
  expect(draft?.document_ids).toHaveLength(2);
  errors.assertClean();
});

test("문서 삭제 — 다중 선택 확인 대화상자 · 원본 보존 · 목록에서 사라짐 · 같은 파일 재등록", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoDocuments(page);
  await expect(documentsTable(page).getByRole("row")).toHaveCount(8); // 헤더 + 시드 6 + 등록한 복사본 1
  const before = await api(page, "GET", "/documents");
  const idOf = (name: string) => (before.json.items.find((d: { document_name: string }) => d.document_name === name) || {}).document_id as string;
  const removedIds = IDENTICAL.map(idOf);
  expect(removedIds.filter(Boolean)).toHaveLength(2);

  // ---- 체크박스 2건 → 선택 바 → '삭제' → 확인 대화상자(§7 문구 그대로).
  for (const name of IDENTICAL) await page.getByRole("checkbox", { name: `${name} 선택` }).check();
  const selection = page.getByRole("region", { name: "선택한 문서" });
  await expect(selection.getByRole("button")).toHaveText(["선택 해제", "데이터 빌드에 추가", "삭제"]);
  await expect(selection).toContainText("2개 선택");
  await selection.getByRole("button", { name: "삭제", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "문서 삭제" });
  await expect(confirm).toBeVisible();
  await expect(confirm).toHaveAttribute("aria-modal", "true");
  await expect(confirm.getByRole("heading", { level: 2, name: "문서 삭제" })).toBeVisible();
  await expect(confirm.getByText("문서 2개를 지웁니다. 각 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.")).toBeVisible();
  // 무엇을 지우는지 이름으로 보여 준다.
  await expect(confirm.getByRole("list", { name: "지울 문서" }).getByRole("listitem")).toHaveText(IDENTICAL);
  // 원본 파일 삭제는 기본 해제다 — 되돌릴 수 없는 일을 기본값으로 더 넓히지 않는다.
  const purge = confirm.getByRole("checkbox", { name: "원본 파일도 함께 지우기 (data/raw)" });
  await expect(purge).not.toBeChecked();
  await expect(confirm.getByText("체크하지 않으면 원본 파일은 그대로 남고, 다시 등록하면 같은 문서가 만들어집니다.")).toBeVisible();
  await expect(confirm.getByRole("button", { name: "취소" })).toBeEnabled();
  // 취소하면 아무것도 지우지 않는다.
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(confirm).toHaveCount(0);
  expect((await api(page, "GET", "/documents")).json.items).toHaveLength(7);
  await expect(selection).toContainText("2개 선택");

  // ---- 다시 열어 삭제: POST /documents/delete {document_ids, purge_source:false}.
  await selection.getByRole("button", { name: "삭제", exact: true }).click();
  const deleteRequest = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/documents/delete"));
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  expect((await deleteRequest).postDataJSON()).toEqual({ document_ids: removedIds, purge_source: false });
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: "문서 2개를 지웠습니다." })).toBeVisible();
  // 목록·선택 바에서 사라지고 API에도 없다.
  await expect(documentsTable(page).getByRole("row")).toHaveCount(6);
  await expect(selection).toHaveCount(0);
  for (const name of IDENTICAL) await expect(rowOf(page, name)).toHaveCount(0);
  expect((await api(page, "GET", "/documents")).json.items).toHaveLength(5);
  for (const id of removedIds) expect((await api(page, "GET", `/documents/${id}`)).status).toBe(404);
  // 진실은 원본 파일이다 — 기본값(purge 해제)에서는 그대로 남아 있다.
  for (const name of IDENTICAL) expect(rawFileExists(name), `${name} 원본은 남아 있어야 한다`).toBe(true);

  // ---- 같은 파일을 다시 등록하면 새 문서로 들어온다(프로파일도 다시 붙는다).
  const job = await registerViaApi(page, IDENTICAL);
  expect(job.result.documents.map((d: { document_name: string; status: string }) => [d.document_name, d.status])).toEqual([
    [IDENTICAL[0], "normal"],
    [IDENTICAL[1], "normal"],
  ]);
  await waitForJobs(page);
  await page.reload();
  await expect(documentsTable(page).getByRole("row")).toHaveCount(8);
  for (const name of IDENTICAL) {
    await expect(statusChip(page, name)).toHaveText("정상");
    await expect(rowOf(page, name).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  }
  const after = await api(page, "GET", "/documents");
  const restored = IDENTICAL.map((name) => after.json.items.find((d: { document_name: string }) => d.document_name === name).document_id);
  expect(restored.filter(Boolean)).toHaveLength(2);
  // 지운 문서의 id는 돌아오지 않는다 — 되살아난 것이 아니라 새로 만들어진 문서다.
  for (const id of restored) expect(removedIds).not.toContain(id);
  errors.assertClean();
});

test("문서 삭제 — 단건(상세 드로어) · 원본 파일까지 · 대표 문서 프로파일 초안 · 작업 내역", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoDocuments(page);
  const profilesBefore = await api(page, "GET", "/profiles");
  const profile = profilesBefore.json.items.find((p: { profile_name: string }) => p.profile_name === "공정데이터_A양식");
  expect(profile.status).toBe("approved");
  const detail = await openDocument(page, REFERENCE);

  // ---- 드로어 헤더의 '삭제' → 같은 확인 대화상자(단건 문구).
  await detail.getByRole("button", { name: "삭제", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "문서 삭제" });
  await expect(confirm.getByText(`'${REFERENCE}'을(를) 지웁니다. 이 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.`)).toBeVisible();
  // 단건에는 이름 목록을 따로 두지 않는다(확인 문구가 이미 이름을 말한다).
  await expect(confirm.getByRole("list", { name: "지울 문서" })).toHaveCount(0);
  // 대표 문서를 지우면 프로파일이 초안으로 내려간다 — 끝난 뒤의 토스트가 아니라 확인 전에 알린다(§4.13).
  await expect(confirm.getByText("대표 문서입니다 — 파싱 프로파일 '공정데이터_A양식'", { exact: false })).toBeVisible();
  // ---- 이번에는 원본 파일까지 지운다.
  const purge = confirm.getByRole("checkbox", { name: "원본 파일도 함께 지우기 (data/raw)" });
  await expect(purge).not.toBeChecked();
  await purge.check();
  expect(rawFileExists(REFERENCE)).toBe(true);
  const deleteRequest = page.waitForRequest((r) => r.method() === "DELETE" && r.url().includes("/api/documents/"));
  await confirm.getByRole("button", { name: "삭제", exact: true }).click();
  expect((await deleteRequest).url()).toContain("purge_source=true");
  await expect(confirm).toHaveCount(0);
  // 드로어도 닫힌다(지운 문서를 열어 둔 채로 두지 않는다).
  await expect(detail).toHaveCount(0);
  await expect(page).not.toHaveURL(/document=/);

  // ---- 요약: 지운 수 · 원본 파일 · 초안으로 내려간 프로파일.
  const toast = page.locator(".app-toast").filter({ hasText: "문서 1개를 지웠습니다." });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("원본 파일 1개도 지웠습니다.");
  await expect(toast).toContainText("파싱 프로파일 1개가 초안으로 내려갔습니다 — 대표 문서를 다시 지정해 승인하세요.");
  expect(rawFileExists(REFERENCE), "원본 파일도 지워야 한다").toBe(false);
  // openDocument가 채운 검색어를 지우고 목록 전체를 본다.
  await filters(page).getByLabel("문서 검색").fill("");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(7);
  await expect(rowOf(page, REFERENCE)).toHaveCount(0);

  // ---- 대표 문서가 사라진 프로파일은 초안으로 내려가고 대표 문서 참조가 없다.
  await toast.getByRole("button", { name: "파싱 프로파일 열기" }).click();
  await expect(page).toHaveURL(/screen=profiles/);
  const profileRow = page.getByRole("table", { name: "파싱 프로파일 목록" }).getByRole("row").filter({ hasText: "공정데이터_A양식" });
  await expect(profileRow.getByRole("cell").nth(4).locator(".app-chip")).toHaveText("초안");
  const reloaded = await api(page, "GET", `/profiles/${profile.profile_id}`);
  expect(reloaded.json.status).toBe("draft");
  expect(reloaded.json.reference?.application_id ?? null).toBeNull();

  // ---- 작업 내역: 단건 `<문서명> 삭제`와 다중 `문서 N개 삭제`가 남는다(대상은 작업 공간, 이동 버튼 없음).
  await openScreen(page, "작업 내역");
  const jobsCard = page.getByRole("region", { name: "작업 목록 카드" });
  await jobsCard.getByLabel("종류").selectOption("delete");
  await expect(page).toHaveURL(/kind=delete/);
  const jobRows = page.getByRole("table", { name: "작업 목록" }).locator("tbody tr");
  await expect(jobRows).toHaveCount(2);
  await expect(jobRows.locator("td:nth-child(1)")).toHaveText(["삭제", "삭제"]);
  await expect(jobRows.locator("td:nth-child(2)")).toHaveText([`${REFERENCE} 삭제`, "문서 2개 삭제"]);
  await expect(jobRows.locator("td:nth-child(3) .app-chip")).toHaveText(["완료", "완료"]);
  await expect(jobRows.first().locator("td:nth-child(6)")).toContainText("문서 1개를 지웠습니다.");
  await expect(jobRows.nth(1).locator("td:nth-child(6)")).toContainText("문서 2개를 지웠습니다.");
  for (const row of await jobRows.all()) await expect(row.getByRole("button", { name: "이동" })).toHaveCount(0);
  // API 기록도 같은 값이다.
  const jobs = await api(page, "GET", "/jobs?kind=delete");
  expect(jobs.json.items).toHaveLength(2);
  expect(jobs.json.items[0]).toMatchObject({ kind: "delete", state: "succeeded", target_kind: "workspace", target_id: null });
  expect(jobs.json.items[0].result.summary).toEqual({ requested: 1, deleted: 1, failed: 0 });
  expect(jobs.json.items[0].result.documents[0]).toMatchObject({ document_name: REFERENCE, source_ref: REFERENCE, source_removed: true });
  expect(jobs.json.items[0].result.profiles_reset).toEqual([{ profile_id: profile.profile_id, profile_name: "공정데이터_A양식" }]);
  errors.assertClean();
});

test("문서 삭제 거부 — 없는 문서 404 · 빈 목록 422 · 상한 초과 422", async ({ page }) => {
  const errors = collectErrors(page);
  const missing = await api(page, "DELETE", "/documents/00000000-0000-4000-8000-000000000000");
  expect(missing.status).toBe(404);
  expect(missing.json.error.code).toBe("UNKNOWN_DOCUMENT");
  const empty = await api(page, "POST", "/documents/delete", { document_ids: [] });
  expect(empty.status).toBe(422);
  expect(empty.json.error.code).toBe("VALIDATION_ERROR");
  const tooMany = await api(page, "POST", "/documents/delete", { document_ids: Array.from({ length: 201 }, (_, i) => `id-${i}`) });
  expect(tooMany.status).toBe(422);
  expect(tooMany.json.error.code).toBe("TOO_MANY_DOCUMENTS");
  expect(tooMany.json.error.message).toBe("한 번에 최대 200개까지 지울 수 있습니다. 나누어 지우세요.");
  // 거부된 요청은 아무것도 지우지 않았다.
  expect((await api(page, "GET", "/documents")).json.items).toHaveLength(6);
  errors.assertClean();
});
