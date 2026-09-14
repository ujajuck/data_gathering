// 문서 화면 E2E(계약 §8 documents.spec): 쉘·표·필터·정렬 → 등록 대화상자·상세 드로어·잠긴 문서 → 새 snapshot·데이터 빌드 인계.
// 세 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false). 1번은 시드 6건을 그대로 보고, 2번이 7번째 문서를 등록하며,
// 3번이 대표 문서를 바꿔 새 snapshot을 만든다. 모든 단언은 실제 표시 문구(한국어 라벨·셀 텍스트)를 본다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, copyRawDocument, mutateFirstDocument, openDocument, openScreen, registerViaApi, resetWorkspace, waitForJobs } from "./helpers";

const REFERENCE = "공정데이터_2024_01.xlsx";
const IDENTICAL = ["공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"];
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const OTHER = "품질검사_2024_05.xlsx";
const LOCKED = "공정데이터_2024_06_잠김.xlsx";
const NEW_COPY = "공정데이터_2024_07.xlsx";
const PROFILE_V1 = "공정데이터_A양식 v1";
const SCHEMA_NAME = "공정 데이터 표준";
const STATUS_LABELS = ["정상", "검수 필요", "변경 감지", "프로파일 없음", "재추출 필요", "파싱 실패", "잠김(DRM)"];
const DRM_MESSAGE = "암호화 문서는 승인된 보안 읽기 어댑터로 접근해야 합니다.";

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
