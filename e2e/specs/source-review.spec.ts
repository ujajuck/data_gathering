// Source Review E2E(계약 §8 source-review.spec): 실제 셀 · overlay · 드래그 재지정 · 승인→추출 요청 1회 · 모두 승인 · 변경 이력/복원 · 반려 ·
// 역방향 조회(API) · 창 요청(스크롤) · 잠긴 문서와 뷰어 실패 상태. 세 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false).
// 1번은 시드의 검수 대기 문서(공정데이터_2024_04_양식이동.xlsx, compatible → 제안 11개)를 검수해 발행까지 간다.
// 2번은 60행·26열을 넘는 문서를 등록해 뷰어가 두 번째 창을 요청하는지 본다. 3번은 잠긴 문서와 DRM 실패 상태(다시 시도)를 본다.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { DRM_MESSAGE, api, collectErrors, openDocument, openScreen, registerViaApi, resetWorkspace, runPython, waitForJobs, workspaceRoot } from "./helpers";

const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const LOCKED = "공정데이터_2024_06_잠김.xlsx";
const SWAPPED = "공정데이터_2024_02.xlsx";
const WIDE = "공정데이터_2024_08_확장.xlsx";
const PROFILE_V1 = "공정데이터_A양식 v1";
const SCHEMA_V1 = "공정 데이터 표준 v1";
const MAIN_SHEET = "공정 기록";
const COMMON_SHEET = "공통 정보";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type Region = { role: string; sheet_id: string; sheet_name: string; range: string };
type Mapping = { mapping_id: string; rule_key: string; rule_name: string; status: string; edit_seq: number; revision_no: number; regions: Region[]; value: unknown };
type Summary = {
  application_id: string;
  compatibility: string;
  published: boolean;
  heads_approved: number;
  heads_total: number;
  document: { document_id: string; document_name: string };
  snapshot: { snapshot_id: string; revision_no: number; captured_at: string };
  sheets: { sheet_id: string; sheet_name: string; roles: string[] }[];
  mappings: Mapping[];
};

const reviewDialog = (page: Page) => page.getByRole("dialog", { name: "Source Review" });
const viewerOf = (scope: Locator) => scope.locator(".app-viewer");
const cellOf = (scope: Locator, ref: string) => scope.locator(`.app-cell[data-ref="${ref}"]`);
const rulesOf = (scope: Locator) => scope.getByRole("group", { name: "파싱 규칙 목록" });
const ruleItem = (page: Page, scope: Locator, name: string) => rulesOf(scope).locator(".app-list-item").filter({ has: page.locator(`strong:text-is("${name}")`) });
const panelOf = (scope: Locator) => scope.locator('[data-testid="mapping-panel"]');
// 패널 메시지(승인됨·복원됨·반려됨…): 패널 루트 바로 아래의 app-note(변경 이력의 '불러오는 중…' role=status와 구분).
const messageOf = (panel: Locator) => panel.locator(":scope > .app-note[role='status']");
const kvOf = (panel: Locator, index: number) => panel.locator("dl.app-kv dd").nth(index);

// 검수 대기 문서의 application_id: GET /documents → /snapshots/{sid}/applications → GET /applications/{aid}.
async function shiftedApplication(page: Page): Promise<Summary> {
  const documents = await api(page, "GET", "/documents?q=" + encodeURIComponent(SHIFTED));
  expect(documents.status).toBe(200);
  expect(documents.json.items).toHaveLength(1);
  const snapshotId = documents.json.items[0].current_snapshot.snapshot_id as string;
  const applications = await api(page, "GET", `/snapshots/${snapshotId}/applications`);
  expect(applications.status).toBe(200);
  expect(applications.json.items).toHaveLength(1);
  expect(applications.json.items[0]).toMatchObject({ compatibility: "compatible", state: "review", published: false, heads_approved: 0, heads_total: 11 });
  const summary = await api<Summary>(page, "GET", "/applications/" + applications.json.items[0].application_id);
  expect(summary.status).toBe(200);
  return summary.json;
}

// 렌더 창 GET의 range=와 /api POST 경로를 모은다(창 요청 수·승인 요청 1회 검사용).
function trackRequests(page: Page) {
  const renders: string[] = [];
  const posts: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    const render = /\/render\?range=([^&]+)/.exec(url);
    if (request.method() === "GET" && render) renders.push(decodeURIComponent(render[1]));
    if (request.method() === "POST" && url.includes("/api/")) posts.push(url.replace(/^.*\/api/, ""));
  });
  return { renders, posts };
}

// 드래그(review 모드): 포인터를 누른 셀에서 다른 셀까지 끌어 놓는다.
async function dragCells(page: Page, from: Locator, to: Locator) {
  await from.hover();
  await page.mouse.down();
  await to.hover();
  await page.mouse.up();
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("검수 화면: 컨텍스트 · 시트/규칙 목록 · 실제 셀 · overlay · 확대 · 셀 이동 → 드래그 재지정 · 승인(요청 1회) · 모두 승인 · 이력/복원 · 반려 · 역방향 조회", async ({ page }) => {
  const errors = collectErrors(page);
  const summary = await shiftedApplication(page);
  const applicationId = summary.application_id;
  const main = summary.sheets.find((s) => s.sheet_name === MAIN_SHEET)!;
  const common = summary.sheets.find((s) => s.sheet_name === COMMON_SHEET)!;
  expect(main.roles).toEqual(["main"]);
  expect(common.roles).toEqual(["common"]);
  const temperature = summary.mappings.find((m) => m.rule_key === "temperature")!;
  expect(temperature).toMatchObject({ status: "proposed", edit_seq: 1, revision_no: 1, value: null });
  expect(temperature.regions).toEqual([
    { role: "key", sheet_id: main.sheet_id, sheet_name: MAIN_SHEET, range: "C11" },
    { role: "value", sheet_id: main.sheet_id, sheet_name: MAIN_SHEET, range: "C12:C71" },
    { role: "unit", sheet_id: common.sheet_id, sheet_name: COMMON_SHEET, range: "B1" },
  ]);
  const requests = trackRequests(page);

  await page.goto(`/?review=${applicationId}&rule=temperature`);
  const review = reviewDialog(page);
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");

  // 컨텍스트 줄: 문서명 · snapshot 날짜 / 시트 / 프로파일 vN / 스키마 vN · 미발행 · 승인 0/11 · 호환 · 모두 승인 (11).
  const context = review.locator(".app-context").first();
  await expect(context.locator("strong")).toHaveText(SHIFTED);
  await expect(context).toContainText(summary.snapshot.captured_at.slice(0, 10));
  await expect(context).toContainText(`/ ${MAIN_SHEET}`);
  await expect(context).toContainText(`/ ${PROFILE_V1}`);
  await expect(context).toContainText(`/ ${SCHEMA_V1}`);
  await expect(context.locator(".app-chip")).toHaveText(["미발행", "승인 0/11", "호환"]);
  await expect(context.locator(".app-chip").nth(0)).toHaveClass(/\bwarn\b/);
  await expect(context.getByRole("button", { name: "모두 승인 (11)" })).toBeEnabled();

  // 좌측: 시트 목록(역할) · 프로파일/스키마 · 파싱 규칙 11개(제안 칩), 온도가 선택됨.
  const sheets = review.getByRole("group", { name: "시트 목록" });
  await expect(sheets.getByRole("button")).toHaveCount(2);
  await expect(sheets.getByRole("button").nth(0)).toContainText(MAIN_SHEET);
  await expect(sheets.getByRole("button").nth(0)).toContainText("역할: main");
  await expect(sheets.getByRole("button").nth(0)).toHaveAttribute("aria-current", "true");
  await expect(sheets.getByRole("button").nth(1)).toContainText(COMMON_SHEET);
  await expect(sheets.getByRole("button").nth(1)).toContainText("역할: common");
  const side = review.getByRole("region", { name: "시트와 파싱 규칙" });
  await expect(side.locator("p.app-small strong")).toHaveText(PROFILE_V1);
  await expect(side.locator("p.app-small .app-muted")).toHaveText(SCHEMA_V1);
  const rules = rulesOf(review);
  await expect(rules.locator(".app-list-item")).toHaveCount(11);
  await expect(rules.locator(".app-list-item strong")).toHaveText(["제품명", "레시피명", "공정명", "설비명", "배치", "측정일시", "온도", "압력", "시간", "결과값", "판정"]);
  await expect(rules.locator(".app-list-item .app-chip")).toHaveText(Array(11).fill("제안"));
  await expect(rules.locator(".app-list-item .app-chip").first()).toHaveClass(/\bwarn\b/);
  await expect(ruleItem(page, review, "온도")).toHaveAttribute("aria-current", "true");
  await expect(ruleItem(page, review, "온도").locator("small")).toHaveText("온도");

  // 중앙: SheetViewer(review)가 실제 셀을 그린다(첫 요청은 202 → 렌더링 중 → 200).
  const viewer = viewerOf(review);
  await expect(viewer).toHaveClass(/\breview\b/);
  await expect(cellOf(viewer, "C11")).toHaveText("온도", { timeout: 60_000 });
  await expect(cellOf(viewer, "C11")).toHaveClass(/\bbold\b/);
  await expect(cellOf(viewer, "C11")).toHaveAttribute("aria-label", "C11 온도");
  await expect(cellOf(viewer, "C12")).toHaveText("150");
  await expect(cellOf(viewer, "C13")).toHaveText("152.5");
  await expect(cellOf(viewer, "A12")).toHaveText("LOT-04-001");
  await expect(cellOf(viewer, "A7")).toHaveText("※ 양식 개정: 표 위치 변경");
  await expect(cellOf(viewer, "A1")).toHaveAttribute("data-range", "A1:G1");
  await expect(viewer.locator(".app-viewer-toolbar")).toContainText(`${MAIN_SHEET} · 60행 × 26열`);
  await expect(viewer.getByText("렌더링 중")).toHaveCount(0);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await expect(viewer.locator(".app-legend")).toContainText("키");
  const cellCount = await viewer.locator(".app-cell").count();
  expect(cellCount).toBeGreaterThan(0);
  expect(cellCount).toBeLessThanOrEqual(3000);
  expect(requests.renders.every((range) => range === "A1:Z60")).toBe(true);

  // overlay: 온도 규칙의 키 C11 · 값 C12:C71(현재 시트), 단위는 공통 정보 시트에만.
  const overlay = (kind: string) => viewer.locator(`.app-overlay.${kind}`);
  await expect(overlay("key")).toHaveCount(1);
  await expect(overlay("key")).toHaveAttribute("data-range", "C11");
  await expect(overlay("key").locator(".app-overlay-label")).toHaveText("키");
  await expect(overlay("value")).toHaveCount(1);
  await expect(overlay("value")).toHaveAttribute("data-range", "C12:C71");
  await expect(overlay("value").locator(".app-overlay-label")).toHaveText("값");
  await expect(overlay("unit")).toHaveCount(0);
  await sheets.getByRole("button", { name: new RegExp(COMMON_SHEET) }).click();
  await expect(page).toHaveURL(new RegExp(`sheet=${common.sheet_id}`));
  await expect(cellOf(viewer, "A1")).toHaveText("온도 단위", { timeout: 60_000 });
  await expect(cellOf(viewer, "B1")).toHaveText("°C");
  await expect(overlay("unit")).toHaveCount(1);
  await expect(overlay("unit")).toHaveAttribute("data-range", "B1");
  await expect(overlay("unit").locator(".app-overlay-label")).toHaveText("단위");
  await expect(overlay("key")).toHaveCount(0);
  await expect(overlay("value")).toHaveCount(0);
  await expect(context).toContainText(`/ ${COMMON_SHEET}`);
  await sheets.getByRole("button", { name: new RegExp(MAIN_SHEET) }).click();
  await expect(cellOf(viewer, "C11")).toHaveText("온도", { timeout: 60_000 });
  await expect(overlay("value")).toHaveAttribute("data-range", "C12:C71");

  // 확대 select → transform: scale, A1 이동 → 초점 셀.
  const zoom = review.getByLabel("확대");
  await expect(zoom.locator("option")).toHaveText(["50%", "75%", "100%", "125%", "150%"]);
  await expect(zoom).toHaveValue("1");
  await zoom.selectOption("0.75");
  await expect(viewer.locator(".app-sheet")).toHaveCSS("transform", /matrix\(0\.75, 0, 0, 0\.75, 0, 0\)/);
  await zoom.selectOption("1");
  await expect(viewer.locator(".app-sheet")).toHaveCSS("transform", /matrix\(1, 0, 0, 1, 0, 0\)|none/);
  await viewer.getByLabel("셀 이동").fill("G23");
  await viewer.getByRole("button", { name: "이동" }).click();
  await expect(viewer.locator(".app-cell.focused")).toHaveAttribute("data-ref", "G23");
  await expect(cellOf(viewer, "G23")).toHaveText("합격");
  await expect(cellOf(viewer, "G23")).toHaveAttribute("tabindex", "0");
  await viewer.getByLabel("셀 이동").fill("nope");
  await viewer.getByRole("button", { name: "이동" }).click();
  await expect(viewer.getByText("A1 형식으로 입력하세요")).toBeVisible();
  await expect(viewer.getByLabel("셀 이동")).toHaveAttribute("aria-invalid", "true");

  // 우측 패널(온도): 필드 · 파싱 규칙 · 관찰된 키 · 추출값 없음 · 원본 위치 Sheet!Range · 상태 제안.
  const panel = panelOf(review);
  await expect(panel).toHaveAttribute("data-mapping-status", "proposed");
  await expect(panel.locator("h3")).toHaveText("온도");
  await expect(panel.locator("h3 + .app-chip")).toHaveText("제안");
  await expect(panel.locator("h3 + .app-chip")).toHaveClass(/\bwarn\b/);
  await expect(panel.locator("dl.app-kv dt")).toHaveText(["필드", "파싱 규칙", "관찰된 키", "추출값", "원본 위치", "상태"]);
  await expect(kvOf(panel, 0).locator("strong")).toHaveText("온도");
  await expect(kvOf(panel, 0)).toContainText("decimal · °C");
  await expect(kvOf(panel, 1)).toHaveText("온도");
  await expect(kvOf(panel, 2)).toHaveText("-");
  await expect(kvOf(panel, 3)).toHaveText("없음 (승인 후 추출)");
  await expect(kvOf(panel, 4).getByRole("button")).toHaveText([`키: ${MAIN_SHEET}!C11`, `값: ${MAIN_SHEET}!C12:C71`, `단위: ${COMMON_SHEET}!B1`]);
  await expect(kvOf(panel, 5)).toHaveText("제안 · 프로파일 · #1");
  await expect(panel.getByRole("group", { name: "검수 행동" }).getByRole("button")).toHaveText(["수정", "승인", "반려"]);
  await expect(panel.getByRole("button", { name: "승인", exact: true })).toBeEnabled();
  expect(await review.innerText()).not.toMatch(UUID);
  // 원본 위치 클릭 → ?range=로 초점 이동.
  await kvOf(panel, 4).getByRole("button", { name: `키: ${MAIN_SHEET}!C11` }).click();
  await expect(page).toHaveURL(/range=C11/);

  // 드래그 재지정: 역할 '값'을 고르고 C12→C23을 끌면 새 위치가 overlay와 패널에 바로 반영된다.
  const roles = review.getByRole("group", { name: "선택 역할" });
  await expect(roles.getByRole("button")).toHaveText(["키", "값", "단위", "문맥"]);
  await roles.getByRole("button", { name: "값" }).click();
  await expect(roles.getByRole("button", { name: "값" })).toHaveAttribute("aria-pressed", "true");
  await dragCells(page, cellOf(viewer, "C12"), cellOf(viewer, "C23"));
  await expect(overlay("value")).toHaveCount(1);
  await expect(overlay("value")).toHaveAttribute("data-range", "C12:C23");
  await expect(overlay("drag")).toHaveCount(0);
  await expect(panel.getByText("원본 위치 변경됨")).toBeVisible();
  await expect(kvOf(panel, 4).getByRole("button", { name: `값: ${MAIN_SHEET}!C12:C23` })).toBeVisible();
  await expect(kvOf(panel, 4).getByText("새 위치")).toBeVisible();
  await expect(kvOf(panel, 4).getByRole("button", { name: "값 재지정 취소" })).toBeVisible();

  // 승인: POST /mappings/{mid}/revisions 한 번(extract true, 바뀐 값 영역 포함) → 승인 칩 · #2 · 승인 1/11.
  requests.posts.length = 0;
  const [revisionRequest] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/mappings/${temperature.mapping_id}/revisions`)),
    panel.getByRole("button", { name: "승인", exact: true }).click(),
  ]);
  const revisionBody = revisionRequest.postDataJSON();
  expect(revisionBody).toMatchObject({ expected_seq: 1, status: "approved", extract: true });
  expect(revisionBody.regions).toHaveLength(3);
  expect(revisionBody.regions).toEqual(
    expect.arrayContaining([
      { role: "key", sheet_id: main.sheet_id, range: "C11" },
      { role: "value", sheet_id: main.sheet_id, range: "C12:C23" },
      { role: "unit", sheet_id: common.sheet_id, range: "B1" },
    ]),
  );
  await expect(messageOf(panel)).toHaveText("승인됨");
  await expect(context.locator(".app-chip").nth(1)).toHaveText("승인 1/11");
  expect(requests.posts).toEqual([`/mappings/${temperature.mapping_id}/revisions`]);
  await expect(panel).toHaveAttribute("data-mapping-status", "approved");
  await expect(panel.locator("h3 + .app-chip")).toHaveText("승인");
  await expect(panel.locator("h3 + .app-chip")).toHaveClass(/\bok\b/);
  await expect(kvOf(panel, 5)).toHaveText("승인 · 수동 · #2");
  await expect(kvOf(panel, 4).getByRole("button")).toHaveText([`키: ${MAIN_SHEET}!C11`, `값: ${MAIN_SHEET}!C12:C23`, `단위: ${COMMON_SHEET}!B1`]);
  await expect(panel.getByText("원본 위치 변경됨")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "승인", exact: true })).toBeDisabled();
  await expect(ruleItem(page, review, "온도").locator(".app-chip")).toHaveText("승인");
  await expect(overlay("value")).toHaveAttribute("data-range", "C12:C23");
  await expect(context.getByRole("button", { name: "모두 승인 (10)" })).toBeEnabled();
  const afterApprove = await api<Summary>(page, "GET", "/applications/" + applicationId);
  expect(afterApprove.json.heads_approved).toBe(1);
  expect(afterApprove.json.mappings.find((m) => m.rule_key === "temperature")).toMatchObject({ status: "approved", revision_no: 2, edit_seq: 2 });

  // 모두 승인: 남은 10개를 승인하고 같은 요청에서 추출 → 배너 · 발행됨 · 승인 11/11 · 추출값이 패널에 보인다.
  requests.posts.length = 0;
  await context.getByRole("button", { name: "모두 승인 (10)" }).click();
  const banner = review.locator('[data-testid="approve-all-result"]');
  await expect(banner).toHaveText(/^모두 승인 · 추출 완료 · 값 88개 · 승인 10개 · 발행됨/, { timeout: 60_000 });
  await expect(banner).toHaveClass(/\bapp-note\b/);
  expect(requests.posts).toEqual([`/applications/${applicationId}/approve-all?wait=20`]);
  await expect(context.locator(".app-chip")).toHaveText(["발행됨", "승인 11/11", "호환"]);
  await expect(context.locator(".app-chip").nth(0)).toHaveClass(/\bok\b/);
  await expect(context.getByRole("button", { name: "모두 승인" })).toBeDisabled();
  await expect(rules.locator(".app-list-item .app-chip")).toHaveText(Array(11).fill("승인"));
  await expect(kvOf(panel, 3).locator("strong")).toHaveText("150 °C");
  await expect(kvOf(panel, 3)).toContainText("값 12개 중 첫 값");
  await expect(kvOf(panel, 3)).toContainText(`${MAIN_SHEET}!C12`);
  await banner.getByRole("button", { name: "닫기" }).click();
  await expect(banner).toHaveCount(0);
  const published = await api<Summary>(page, "GET", "/applications/" + applicationId);
  expect(published.json).toMatchObject({ published: true, heads_approved: 11, heads_total: 11 });
  const values = await api(page, "GET", `/applications/${applicationId}/values?rule_key=temperature`);
  expect(values.json.items).toHaveLength(12);
  expect(values.json.items[0]).toMatchObject({ rule_key: "temperature", value_text: "150", first_region: { sheet_name: MAIN_SHEET, range: "C12" } });
  const shiftedDocument = await api(page, "GET", "/documents/" + summary.document.document_id);
  expect(shiftedDocument.json.status).toBe("normal");

  // 변경 이력: 펼칠 때만 GET /mappings/{mid}/revisions → #2(현재) · #1, 복원 → rollback → #3(제안, 원래 C12:C71).
  const history = panel.locator("details").filter({ hasText: "변경 이력" });
  const [revisionsRequest] = await Promise.all([
    page.waitForRequest((r) => r.method() === "GET" && r.url().includes(`/mappings/${temperature.mapping_id}/revisions`)),
    history.locator("summary").click(),
  ]);
  expect(revisionsRequest.url()).toContain(`/mappings/${temperature.mapping_id}/revisions`);
  const table = history.getByRole("table", { name: "변경 이력" });
  await expect(table.getByRole("columnheader")).toHaveText(["리비전", "상태", "필드", "출처", "사유", ""]);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const row = (i: number) => table.locator("tbody tr").nth(i);
  await expect(row(0).getByRole("cell").nth(0)).toHaveText(/^#2 · \d{4}-\d{2}-\d{2} \d{2}:\d{2} 현재$/);
  await expect(row(0).getByRole("cell").nth(1)).toHaveText("승인");
  await expect(row(0).getByRole("cell").nth(2)).toHaveText("온도");
  await expect(row(0).getByRole("cell").nth(3)).toHaveText("수동");
  await expect(row(0).getByRole("cell").nth(4)).toHaveText("원본 영역/필드 검수");
  await expect(row(0).getByRole("button", { name: "복원" })).toHaveCount(0);
  await expect(row(1).getByRole("cell").nth(0)).toHaveText(/^#1 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  await expect(row(1).getByRole("cell").nth(1)).toHaveText("제안");
  await expect(row(1).getByRole("cell").nth(3)).toHaveText("프로파일");
  await expect(row(1).getByRole("cell").nth(4)).toHaveText("-");
  expect(await history.innerText()).not.toMatch(UUID);
  requests.posts.length = 0;
  const [rollbackRequest] = await Promise.all([
    page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/mappings/${temperature.mapping_id}/rollback`)),
    row(1).getByRole("button", { name: "복원" }).click(),
  ]);
  expect(rollbackRequest.postDataJSON()).toMatchObject({ expected_seq: 2 });
  expect(rollbackRequest.postDataJSON().target_revision_id).toMatch(UUID);
  await expect(messageOf(panel)).toHaveText("복원됨");
  await expect(kvOf(panel, 5)).toHaveText("제안 · 수동 · #3");
  await expect(panel.locator("h3 + .app-chip")).toHaveText("제안");
  await expect(kvOf(panel, 4).getByRole("button", { name: `값: ${MAIN_SHEET}!C12:C71` })).toBeVisible();
  await expect(overlay("value")).toHaveAttribute("data-range", "C12:C71");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(row(0).getByRole("cell").nth(0)).toHaveText(/^#3 · .* 현재$/);
  await expect(row(0).getByRole("cell").nth(1)).toHaveText("제안");
  await expect(row(0).getByRole("cell").nth(4)).toHaveText("리비전 #1 복원");
  expect(requests.posts).toEqual([`/mappings/${temperature.mapping_id}/rollback`]);
  // 승인된 헤드가 바뀌었으므로 발행이 풀리고 승인 10/11이 된다.
  await expect(context.locator(".app-chip")).toHaveText(["미발행", "승인 10/11", "호환"]);
  await expect(context.getByRole("button", { name: "모두 승인 (1)" })).toBeEnabled();

  // 반려: 반려 → 사유 입력 → 반려 확정 → 반려 칩 · #4, 그 뒤 다시 승인하면 전부 승인 → 추출 → 발행.
  await panel.getByRole("button", { name: "반려", exact: true }).click();
  await expect(panel.getByRole("button", { name: "반려 확정" })).toBeVisible();
  await panel.getByLabel("반려 사유").fill("표 위치 재확인 필요");
  await panel.getByRole("button", { name: "반려 확정" }).click();
  await expect(messageOf(panel)).toHaveText("반려됨");
  await expect(panel).toHaveAttribute("data-mapping-status", "rejected");
  await expect(panel.locator("h3 + .app-chip")).toHaveText("반려");
  await expect(panel.locator("h3 + .app-chip")).toHaveClass(/\berr\b/);
  await expect(kvOf(panel, 5)).toHaveText("반려 · 수동 · #4");
  await expect(panel.getByRole("button", { name: "반려", exact: true })).toBeDisabled();
  await expect(ruleItem(page, review, "온도").locator(".app-chip")).toHaveText("반려");
  await expect(row(0).getByRole("cell").nth(0)).toHaveText(/^#4 · .* 현재$/);
  await expect(row(0).getByRole("cell").nth(1)).toHaveText("반려");
  await expect(row(0).getByRole("cell").nth(4)).toHaveText("표 위치 재확인 필요");
  await panel.getByRole("button", { name: "승인", exact: true }).click();
  // wait=0이라 추출은 큐에 들어가고(승인됨 · 추출 진행 중…) 뷰가 작업을 폴링해 마무리한다.
  await expect(messageOf(panel)).toHaveText(/추출 완료 · 값 88개 · 발행됨$/, { timeout: 60_000 });
  await expect(kvOf(panel, 5)).toHaveText("승인 · 수동 · #5");
  await expect(context.locator(".app-chip")).toHaveText(["발행됨", "승인 11/11", "호환"]);
  await expect(kvOf(panel, 3).locator("strong")).toHaveText("150 °C");
  await expect(kvOf(panel, 3)).toContainText("값 12개 중 첫 값");
  await waitForJobs(page);

  // 역방향 조회는 화면에 없어 API로 확인한다: 셀 C12 → 그 영역의 값(온도 150, 발행)과 참조 매핑(온도 헤드 C12:C71).
  const regions = await api(page, "GET", `/sheets/${main.sheet_id}/regions?range=C12`);
  expect(regions.status).toBe(200);
  expect(regions.json.sheet).toMatchObject({ sheet_id: main.sheet_id, sheet_name: MAIN_SHEET });
  const cellRegion = regions.json.items.find((r: { range: string }) => r.range === "C12");
  expect(cellRegion).toMatchObject({ kind: "cells", r1: 12, c1: 3, r2: 12, c2: 3 });
  expect(cellRegion.value_count).toBeGreaterThan(0);
  expect(regions.json.items.some((r: { range: string; mapping_count: number }) => r.range === "C12:C71" && r.mapping_count === 1)).toBe(true);
  const lookup = await api(page, "GET", `/regions/${cellRegion.region_id}/values`);
  expect(lookup.status).toBe(200);
  expect(lookup.json.region).toMatchObject({ sheet_name: MAIN_SHEET, range: "C12" });
  expect(lookup.json.values.length).toBeGreaterThan(0);
  expect(lookup.json.values[0]).toMatchObject({ rule_key: "temperature", value_text: "150", published: true, application_id: applicationId, field: { key: "temperature", name: "온도" } });
  const head = lookup.json.mappings.find((m: { rule_key: string; is_head: boolean }) => m.rule_key === "temperature" && m.is_head);
  expect(head).toMatchObject({ role: "value", mapping_id: temperature.mapping_id, status: "approved", revision_no: 5, range: "C12:C71", rule_name: "온도" });
  expect(JSON.stringify(lookup.json)).not.toMatch(/run_id|mapping_revision_id/);

  // Escape → 오버레이 닫힘, review·rule·sheet·range 제거, 뒤 화면 다시 활성.
  await review.press("Escape");
  await expect(review).toHaveCount(0);
  // 닫기는 review·rule·range(·test·snapshot)만 지운다 — sheet=는 문서 드로어와 공유하는 파라미터라 남는다.
  await expect(page).not.toHaveURL(/review=|rule=|range=/);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();
  errors.assertClean();
});

test("창 요청: 60행·26열을 넘는 문서를 스크롤하면 뷰어가 두 번째 창(A61:… / AA…)을 요청해 그린다", async ({ page }) => {
  const errors = collectErrors(page);
  runPython("import sys; from pathlib import Path; from examples.demo.demo import write_wide_document; print(write_wide_document(Path(sys.argv[1])))", workspaceRoot());
  const job = await registerViaApi(page, [WIDE]);
  const registered = job.result.documents[0];
  expect(registered).toMatchObject({ document_name: WIDE, status: "normal" });
  expect(registered.applied[0]).toMatchObject({ profile_name: "공정데이터_A양식", compatibility: "identical", state: "published" });
  const applicationId = registered.applied[0].application_id as string;
  const requests = trackRequests(page);

  await page.goto(`/?review=${applicationId}&rule=temperature`);
  const review = reviewDialog(page);
  const viewer = viewerOf(review);
  await expect(cellOf(viewer, "C8")).toHaveText("온도", { timeout: 60_000 });
  await expect(cellOf(viewer, "C9")).toHaveText("150");
  await expect(viewer.locator(".app-viewer-toolbar")).toContainText(`${MAIN_SHEET} · 80행 × 30열`);
  // 첫 창 A1:Z60. 초점(C9:C68)으로 스크롤하며 진행 방향 1창(A61:Z80)을 선행 요청할 수는 있지만 Z열 너머 창은 아직 없다.
  const initial = [...new Set(requests.renders)];
  expect(initial).toContain("A1:Z60");
  expect(initial.every((range) => range === "A1:Z60" || range === "A61:Z80")).toBe(true);
  await expect(viewer.locator(".app-overlay.value")).toHaveAttribute("data-range", "C9:C68");

  // 아래로 끝까지: A61:Z80 창을 요청해 61행 이후 셀이 그려진다.
  const scroller = viewer.locator('[data-testid="sheet-scroll"]');
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => requests.renders.includes("A61:Z80"), { message: "두 번째 창(A61:Z80) 요청" }).toBe(true);
  await expect(cellOf(viewer, "C75")).toHaveText("152.5", { timeout: 60_000 });
  await expect(cellOf(viewer, "A80")).toHaveText("LOT-08-072");
  await expect(cellOf(viewer, "C61")).toHaveText("155");
  // 오른쪽으로 끝까지: AA…AD 창을 요청해 Z열 너머 셀이 그려진다.
  await scroller.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  await expect.poll(() => requests.renders.includes("AA61:AD80"), { message: "오른쪽 아래 창(AA61:AD80) 요청" }).toBe(true);
  expect(initial).not.toContain("AA61:AD80");
  await expect(cellOf(viewer, "AD80")).toHaveText("마지막 행 비고", { timeout: 60_000 });
  const distinct = [...new Set(requests.renders)];
  expect(distinct.length).toBeGreaterThanOrEqual(3);
  expect(distinct.every((range) => /^(A1:Z60|A61:Z80|AA1:AD60|AA61:AD80)$/.test(range))).toBe(true);
  await expect(viewer).toHaveAttribute("data-windows", String(distinct.length));
  const cellCount = await viewer.locator(".app-cell").count();
  expect(cellCount).toBeLessThanOrEqual(3000);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  errors.assertClean();
});

test("잠긴 문서: 드로어 파일 보기는 Snapshot 없음 안내, 등록 뒤 잠긴 원본은 뷰어 안에서만 DRM 실패 + 다시 시도 — 나머지 화면은 정상", async ({ page }) => {
  const errors = collectErrors(page);
  // 403 렌더 응답마다 브라우저가 스스로 남기는 "Failed to load resource" 항목(앱의 console.error가 아님)만 허용한다 — 그 수를 세어 정확히 그만큼만 뺀다.
  const DENIED = "console.error: Failed to load resource: the server responded with a status of 403 (Forbidden)";
  let deniedRenders = 0;
  page.on("response", (response) => {
    if (response.status() === 403 && /\/render\?range=/.test(response.url())) deniedRenders++;
  });
  await page.goto("/?screen=documents");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();

  // 시드의 잠긴 문서: snapshot이 없어 뷰어가 아예 뜨지 않는다(빈 상태 문구).
  const locked = await openDocument(page, LOCKED);
  await expect(locked.locator(".app-modal-head .app-chip").first()).toHaveText("잠김(DRM)");
  await expect(locked.getByRole("alert")).toHaveText("최근 오류: " + DRM_MESSAGE);
  await expect(locked.getByRole("tab", { name: "파일 보기" })).toHaveAttribute("aria-selected", "true");
  await expect(locked.getByText("현재 Snapshot이 없어 파일을 보여줄 수 없습니다.")).toBeVisible();
  await expect(locked.locator(".app-viewer")).toHaveCount(0);
  await expect(locked.getByRole("button", { name: "원본 보기" })).toBeDisabled();
  await locked.press("Escape");
  await expect(locked).toHaveCount(0);

  // 등록·발행된 문서의 원본이 나중에 잠기면(ZIP 매직이 아님) 렌더 프록시가 403 DRM_READER_REQUIRED → 뷰어 영역만 실패 + 다시 시도.
  runPython(
    "import sys; from pathlib import Path; from examples.demo.demo import build_locked_file; build_locked_file(Path(sys.argv[1]) / 'data/raw' / sys.argv[2])",
    workspaceRoot(),
    SWAPPED,
  );
  const render = await api(page, "GET", "/documents?q=" + encodeURIComponent(SWAPPED));
  const swappedDocument = render.json.items[0];
  const snapshotId = swappedDocument.current_snapshot.snapshot_id as string;
  const sheets = await api(page, "GET", `/snapshots/${snapshotId}/sheets`);
  const mainSheet = sheets.json.items.find((s: { sheet_name: string }) => s.sheet_name === MAIN_SHEET);
  // 렌더는 비동기다 — 첫 요청은 202(렌더링 중)로 돌아오고, 보안 읽기 어댑터가 없으면 그 다음 폴링에서 403으로 확정된다.
  const renderPath = `/api/snapshots/${snapshotId}/sheets/${mainSheet.sheet_id}/render?range=A1:Z60`;
  let denied = await page.request.get(renderPath);
  for (let i = 0; i < 120 && denied.status() === 202; i++) {
    await page.waitForTimeout(500);
    denied = await page.request.get(renderPath);
  }
  expect(denied.status(), "잠긴 원본 렌더는 403 DRM_READER_REQUIRED로 끝나야 한다").toBe(403);
  // 프록시는 렌더 서버의 failed 본문을 그대로 전달한다(계약 §5: `{status:'failed', error{code,message}, retry_after}`).
  expect(await denied.json()).toEqual({ status: "failed", error: { code: "DRM_READER_REQUIRED", message: DRM_MESSAGE }, retry_after: 60 });

  const detail = await openDocument(page, SWAPPED);
  const sheetList = detail.locator(".app-side-list");
  await expect(sheetList.getByRole("button")).toHaveCount(2);
  const viewer = viewerOf(detail);
  const failure = viewer.locator(".app-viewer-status.failed");
  await expect(failure).toBeVisible({ timeout: 60_000 });
  await expect(failure).toHaveAttribute("role", "alert");
  await expect(failure).toContainText(DRM_MESSAGE);
  await expect(failure.getByRole("button", { name: "다시 시도" })).toBeVisible();
  await expect(failure.getByRole("button", { name: "다시 시도" })).toBeDisabled(); // retry_after(기본 60초) 전
  await expect(viewer.locator(".app-cell")).toHaveCount(0);
  await expect(viewer.getByText("렌더링 중")).toHaveCount(0);
  // 다른 시트로 바꿔도 같은 실패 상태(뷰어 안에서만), 드로어의 나머지 탭은 정상.
  await sheetList.getByRole("button", { name: new RegExp(COMMON_SHEET) }).click();
  await expect(viewer.locator(".app-viewer-status.failed")).toContainText(DRM_MESSAGE, { timeout: 60_000 });
  await detail.getByRole("tab", { name: "추출 결과" }).click();
  await expect(detail.getByRole("table", { name: "추출 결과" }).locator("tbody tr")).toHaveCount(50);

  // 같은 문서의 Source Review(드로어 머리의 원본 보기 — 파일 보기 탭에서는 버튼이 하나뿐이다): 뷰어는 실패, 규칙 목록·패널은 그대로 쓸 수 있다.
  await detail.getByRole("tab", { name: "파일 보기" }).click();
  await detail.getByRole("button", { name: "원본 보기" }).click();
  const review = reviewDialog(page);
  await expect(review).toBeVisible();
  await expect(viewerOf(review).locator(".app-viewer-status.failed")).toContainText(DRM_MESSAGE, { timeout: 60_000 });
  await expect(rulesOf(review).locator(".app-list-item")).toHaveCount(11);
  await expect(rulesOf(review).locator(".app-list-item .app-chip")).toHaveText(Array(11).fill("승인"));
  await expect(panelOf(review).locator("h3")).toHaveText("제품명");
  await expect(kvOf(panelOf(review), 3).locator("strong")).toHaveText("제품-02");
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(detail).toBeVisible();
  await detail.press("Escape");
  await expect(detail).toHaveCount(0);

  // 나머지 화면(사이드바 이동·표)은 영향이 없다.
  await openScreen(page, "설정");
  await expect(page.getByRole("heading", { level: 1, name: "설정" })).toBeVisible();
  await openScreen(page, "문서");
  await expect(page.getByRole("table", { name: "문서 목록" }).getByRole("row")).toHaveCount(8); // 헤더 + 시드 6 + 확장 문서 1
  const status = await api(page, "GET", "/status");
  expect(status.json.render.available).toBe(true);
  expect(deniedRenders).toBeGreaterThan(0);
  const deniedEntries = errors.errors.filter((e) => e === DENIED);
  expect(deniedEntries, "403 렌더 응답 수만큼의 브라우저 리소스 오류").toHaveLength(deniedRenders);
  errors.errors.splice(0, errors.errors.length, ...errors.errors.filter((e) => e !== DENIED));
  errors.assertClean();
});
