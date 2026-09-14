// 작업 내역 화면 E2E(계약 §8 jobs.spec): 요약 카드(GET /queues 실제 수와 일치) · 큐 묶음 행(신규 양식·매핑 검수·파싱 실패) →
// 매핑 검수 전체 승인 → 새 snapshot(변경 감지) 전체 승인 → 실패한 등록 작업 행의 이동 · 재파싱이 도는 동안 JobBar.
// 네 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false). 모든 단언은 실제 표시 문구(한국어 라벨·셀 텍스트)를 본다.
import { test, expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { api, collectErrors, mutateFirstDocument, openScreen, registerViaApi, resetWorkspace, runPython, waitForJobs, workspaceRoot } from "./helpers";

const REFERENCE = "공정데이터_2024_01.xlsx";
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const OTHER = "품질검사_2024_05.xlsx";
const LOCKED = "공정데이터_2024_06_잠김.xlsx";
const HEAVY = "공정데이터_2024_09_대용량.xlsx";
const PROFILE_V1 = "공정데이터_A양식 v1";
const SCHEMA_KEY = "process_standard";
const DRM_MESSAGE = "암호화 문서는 승인된 보안 읽기 어댑터로 접근해야 합니다.";
const RENDER_PORT = process.env.SCHEMA_E2E_RENDER_PORT || "8032";
const QUEUE_LABELS = ["신규 양식", "매핑 검수", "파싱 실패", "변경 감지", "충돌"] as const;
const QUEUE_KINDS = ["unmatched", "review", "failed", "changed", "conflict"] as const;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA_RE = /[0-9a-f]{64}/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

const summaryCards = (page: Page) => page.getByRole("group", { name: "검수 큐 요약" }).getByRole("button");
const queuePanel = (page: Page, label: string) => page.getByRole("region", { name: `${label} 큐`, exact: true });
const groupTable = (page: Page, label: string) => queuePanel(page, label).getByRole("table", { name: `${label} 묶음` });
// 묶음 행(멤버 행은 tr.app-queue-members로 뒤에 붙는다).
const groupRow = (page: Page, label: string) => groupTable(page, label).locator("tbody > tr:not(.app-queue-members)").first();
const memberTable = (page: Page, groupLabel: string) => page.getByRole("table", { name: `${groupLabel} 멤버` });
const jobsTable = (page: Page) => page.getByRole("table", { name: "작업 목록" });
const jobRows = (page: Page) => jobsTable(page).locator("tbody tr");
const jobsCard = (page: Page) => page.getByRole("region", { name: "작업 목록 카드" });
const toast = (page: Page, text: string) => page.locator(".app-toasts").getByRole("status").filter({ hasText: text }).or(page.locator(".app-toast").filter({ hasText: text }));

async function gotoJobs(page: Page, query = "") {
  await page.goto("/?screen=jobs" + query);
  await expect(page.getByRole("heading", { level: 1, name: "작업 내역" })).toBeVisible();
  await expect(summaryCards(page)).toHaveCount(5);
}

async function expectSummary(page: Page, expected: Record<(typeof QUEUE_KINDS)[number], number>) {
  const queues = await api(page, "GET", "/queues");
  expect(queues.status).toBe(200);
  expect(queues.json.summary).toEqual(expected);
  const cards = summaryCards(page);
  for (const [i, kind] of QUEUE_KINDS.entries()) {
    await expect(cards.nth(i).locator("span")).toHaveText(QUEUE_LABELS[i]);
    await expect(cards.nth(i).locator("strong")).toHaveText(String(queues.json.summary[kind]));
  }
  return queues.json as { summary: Record<string, number>; groups: Record<string, any[]> };
}

async function expectNoIds(locator: Locator) {
  const text = await locator.innerText();
  expect(text).not.toMatch(UUID_RE);
  expect(text).not.toMatch(SHA_RE);
}

// 큰 부속 시트가 붙은 compatible 문서(Reader가 열 때마다 수 초) — 재파싱 작업이 '진행 중'으로 보일 만큼 오래 돌게 한다.
function writeHeavyDocument(): string {
  return runPython(
    "import sys; from pathlib import Path; from examples.demo.demo import write_heavy_document; print(write_heavy_document(Path(sys.argv[1]), rows=4000, cols=150))",
    workspaceRoot(),
  ).trim();
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("요약 카드 · 신규 양식/매핑 검수/파싱 실패 큐 · 렌더 서버 상태 · 작업 목록", async ({ page }) => {
  const errors = collectErrors(page);
  // 작업 목록에 테스트·빌드 종류도 보이도록 API로 두 작업을 남긴다(둘 다 동기 작업 기록).
  const reference = (await api(page, "GET", "/documents?q=" + encodeURIComponent(REFERENCE))).json.items[0];
  const profileId = reference.profiles[0].profile_id as string;
  const tested = await api(page, "POST", `/profiles/${profileId}/test`, { snapshot_id: reference.current_snapshot.snapshot_id });
  expect(tested.status).toBe(200);
  expect(tested.json.compatibility).toBe("identical");
  const built = await api(page, "POST", "/builds?wait=30", {
    document_ids: [reference.document_id],
    schema_key: SCHEMA_KEY,
    columns: [
      { field_key: "lot", header: "배치" },
      { field_key: "temperature", header: "온도" },
    ],
    format: "csv",
  });
  expect(built.status).toBe(200);
  expect(built.json.manifest.row_count ?? built.json.row_count ?? 12).toBe(12);

  await page.goto("/");
  await openScreen(page, "작업 내역");
  await expect(page).toHaveURL(/screen=jobs/);
  await expect(page.getByRole("heading", { level: 1, name: "작업 내역" })).toBeVisible();

  // 렌더 서버 상태 한 줄(GET /status.render): 외부 서버(HTTP) + URL + 대기/렌더링 중.
  const renderLine = page.getByRole("status", { name: "렌더 서버 상태" });
  await expect(renderLine).toBeVisible();
  await expect(renderLine).toHaveText(`렌더 서버 외부 서버(HTTP) · http://127.0.0.1:${RENDER_PORT} · 대기 0건 · 렌더링 중 0건`);

  // 요약 카드 = GET /queues.summary (신규 양식 1 · 매핑 검수 1 · 파싱 실패 1 · 변경 감지 0 · 충돌 0).
  const queues = await expectSummary(page, { unmatched: 1, review: 1, failed: 1, changed: 0, conflict: 0 });
  const cards = summaryCards(page);
  // URL에 큐가 없으면 비어 있지 않은 첫 큐(신규 양식)를 고른다.
  await expect(cards.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(cards.nth(1)).toHaveAttribute("aria-pressed", "false");

  // 신규 양식 큐: '신규 양식 후보 · 1문서' 묶음, 프로파일 만들기 → ?screen=profiles&import=1&snapshot=.
  const unmatchedLabel = "신규 양식 후보 · 1문서";
  await expect(queuePanel(page, "신규 양식")).toBeVisible();
  await expect(queuePanel(page, "신규 양식").getByText("같은 원인·같은 양식은 한 행으로 묶여 있습니다.")).toBeVisible();
  await expect(groupTable(page, "신규 양식").getByRole("columnheader")).toHaveText(["펼치기", "대상", "원인", "영향", "처리"]);
  const unmatchedRow = groupRow(page, "신규 양식");
  await expect(unmatchedRow.getByRole("cell").nth(1).locator("strong")).toHaveText(unmatchedLabel);
  await expect(unmatchedRow.getByRole("cell").nth(1)).toContainText(`문서 1개 · 대표 ${OTHER}`);
  await expect(unmatchedRow.getByRole("cell").nth(2)).toHaveText("프로파일 없음 · 시트: 품질 검사");
  await expect(unmatchedRow.getByRole("cell").nth(3)).toHaveText("문서 1개");
  await expect(unmatchedRow.getByRole("button", { name: "프로파일 만들기" })).toBeEnabled();
  await expect(unmatchedRow.getByRole("button", { name: "프로파일 지정" })).toBeEnabled();
  await unmatchedRow.getByRole("button", { name: `${unmatchedLabel} 멤버 펼치기` }).click();
  await expect(unmatchedRow.getByRole("button", { name: `${unmatchedLabel} 멤버 접기` })).toHaveAttribute("aria-expanded", "true");
  const unmatchedMembers = memberTable(page, unmatchedLabel);
  await expect(unmatchedMembers.getByRole("columnheader")).toHaveText(["문서명", "Snapshot", "상태", "원본 보기"]);
  const otherMember = unmatchedMembers.locator("tbody tr");
  await expect(otherMember).toHaveCount(1);
  await expect(otherMember.getByRole("button", { name: OTHER, exact: true })).toBeVisible();
  await expect(otherMember.getByRole("cell").nth(1)).toHaveText(DATE_RE);
  await expect(otherMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("프로파일 없음");
  await expect(otherMember.getByRole("button", { name: "원본 보기" })).toBeDisabled();
  await expect(otherMember.getByRole("button", { name: "원본 보기" })).toHaveAttribute("title", "적용 결과가 없습니다.");
  await expectNoIds(page.locator("main"));
  const unmatchedSnapshot = queues.groups.unmatched[0].representative.snapshot_id as string;
  await unmatchedRow.getByRole("button", { name: "프로파일 만들기" }).click();
  await expect(page).toHaveURL(/screen=profiles/);
  await expect(page).toHaveURL(/import=1/);
  await expect(page).toHaveURL(new RegExp(`snapshot=${unmatchedSnapshot}`));
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "파싱 프로파일", exact: true })).toHaveAttribute("aria-current", "page");
  const importDialog = page.getByRole("dialog", { name: "외부 Profile Import" });
  await expect(importDialog).toBeVisible();
  await expect(importDialog.getByRole("heading", { name: "외부 Profile Import" })).toBeVisible();
  await importDialog.press("Escape");
  await expect(importDialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/import=/);

  // 매핑 검수 큐: 프로파일 v1 묶음(호환 1), 규칙 11개, 멤버 양식이동 문서 → 원본 보기 → ?review=<application_id>.
  await openScreen(page, "작업 내역");
  await summaryCards(page).nth(1).click();
  await expect(page).toHaveURL(/queue=review/);
  await expect(summaryCards(page).nth(1)).toHaveAttribute("aria-pressed", "true");
  const reviewLabel = `${PROFILE_V1} · 매핑 검수 · 1문서`;
  const reviewRow = groupRow(page, "매핑 검수");
  await expect(reviewRow.getByRole("cell").nth(1).locator("strong")).toHaveText(reviewLabel);
  await expect(reviewRow.getByRole("cell").nth(1)).toContainText(`문서 1개 · 대표 ${SHIFTED}`);
  await expect(reviewRow.getByRole("cell").nth(2)).toHaveText("매핑 검수 필요 (호환 1)");
  await expect(reviewRow.getByRole("cell").nth(3)).toContainText("문서 1개");
  await expect(reviewRow.getByRole("cell").nth(3)).toContainText("규칙 11개");
  // 영향 열의 규칙 칩은 rule_key(앞 5개 + 나머지 수)로 표시된다.
  await expect(reviewRow.getByRole("cell").nth(3).locator(".app-chip")).toHaveText(["duration", "equipment", "lot", "measured_at", "pressure"]);
  await expect(reviewRow.getByRole("cell").nth(3)).toContainText("+6");
  await expect(reviewRow.getByRole("button", { name: "검수 열기" })).toBeEnabled();
  await expect(reviewRow.getByRole("button", { name: "전체 승인" })).toBeEnabled();
  await reviewRow.getByRole("button", { name: `${reviewLabel} 멤버 펼치기` }).click();
  const shiftedMember = memberTable(page, reviewLabel).locator("tbody tr");
  await expect(shiftedMember).toHaveCount(1);
  await expect(shiftedMember.getByRole("button", { name: SHIFTED, exact: true })).toBeVisible();
  await expect(shiftedMember.getByRole("cell").nth(1)).toHaveText(DATE_RE);
  await expect(shiftedMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("검수 필요");
  await expect(shiftedMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveClass(/\bwarn\b/);
  await expect(shiftedMember.getByRole("button", { name: "원본 보기" })).toBeEnabled();
  const reviewApplication = queues.groups.review[0].representative.application_id as string;
  await shiftedMember.getByRole("button", { name: "원본 보기" }).click();
  await expect(page).toHaveURL(new RegExp(`review=${reviewApplication}`));
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(review.locator("strong").first()).toHaveText(SHIFTED);
  await expect(review).toContainText(`/ ${PROFILE_V1}`);
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  await expect(page).toHaveURL(/screen=jobs/);
  await expect(page).toHaveURL(/queue=review/);
  await expect(queuePanel(page, "매핑 검수")).toBeVisible();

  // 파싱 실패 큐: 잠김(DRM) 묶음 — 원인은 마지막 오류, 묶음 처리 버튼 없음; 멤버 문서명 → 문서 상세 드로어.
  await summaryCards(page).nth(2).click();
  await expect(page).toHaveURL(/queue=failed/);
  const lockedLabel = "잠김(DRM) · 1문서";
  const lockedRow = groupRow(page, "파싱 실패");
  await expect(lockedRow.getByRole("cell").nth(1).locator("strong")).toHaveText(lockedLabel);
  await expect(lockedRow.getByRole("cell").nth(1)).toContainText(`문서 1개 · 대표 ${LOCKED}`);
  await expect(lockedRow.getByRole("cell").nth(2)).toHaveText(DRM_MESSAGE);
  await expect(lockedRow.getByRole("cell").nth(3)).toHaveText("문서 1개");
  await expect(lockedRow.getByRole("cell").nth(4).getByRole("button")).toHaveCount(0);
  await lockedRow.getByRole("button", { name: `${lockedLabel} 멤버 펼치기` }).click();
  const lockedMember = memberTable(page, lockedLabel).locator("tbody tr");
  await expect(lockedMember).toHaveCount(1);
  await expect(lockedMember.getByRole("cell").nth(1)).toHaveText("-");
  await expect(lockedMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("잠김(DRM)");
  await expect(lockedMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveClass(/\berr\b/);
  await expect(lockedMember.getByRole("cell").nth(2).locator(".app-chip")).toHaveAttribute("title", DRM_MESSAGE);
  await expect(lockedMember.getByRole("button", { name: "원본 보기" })).toBeDisabled();
  const lockedId = queues.groups.failed[0].representative.document_id as string;
  await lockedMember.getByRole("button", { name: LOCKED, exact: true }).click();
  await expect(page).toHaveURL(/screen=documents/);
  await expect(page).toHaveURL(new RegExp(`document=${lockedId}`));
  const lockedDetail = page.getByRole("dialog", { name: "문서 상세" });
  await expect(lockedDetail).toBeVisible();
  await expect(lockedDetail.getByRole("heading", { name: LOCKED, exact: true })).toBeVisible();
  await expect(lockedDetail.getByRole("alert")).toHaveText("최근 오류: " + DRM_MESSAGE);
  await lockedDetail.press("Escape");
  await expect(lockedDetail).toHaveCount(0);

  // 비어 있는 큐(변경 감지 · 충돌)는 빈 상태 문구.
  await openScreen(page, "작업 내역");
  await summaryCards(page).nth(3).click();
  await expect(page).toHaveURL(/queue=changed/);
  await expect(queuePanel(page, "변경 감지").getByText("변경 감지 큐가 비어 있습니다.")).toBeVisible();
  await summaryCards(page).nth(4).click();
  await expect(queuePanel(page, "충돌").getByText("충돌 큐가 비어 있습니다.")).toBeVisible();

  // 작업 목록: 종류·상태 필터 목록, 시드 4건 + 위의 테스트·빌드 2건(최근 순), 상태 칩·시작/종료·결과 요약.
  const kindSelect = jobsCard(page).getByLabel("종류");
  const stateSelect = jobsCard(page).getByLabel("상태");
  await expect(kindSelect.locator("option")).toHaveText(["전체", "등록", "추출", "재파싱", "빌드", "테스트", "묶음 처리"]);
  await expect(stateSelect.locator("option")).toHaveText(["전체", "대기", "진행 중", "완료", "실패", "취소됨"]);
  await expect(jobsTable(page).getByRole("columnheader")).toHaveText(["종류", "대상", "상태", "시작", "종료", "결과/오류"]);
  await expect(jobRows(page)).toHaveCount(6);
  await expect(jobRows(page).locator("td:nth-child(1)")).toHaveText(["빌드", "테스트", "등록", "재파싱", "추출", "등록"]);
  await expect(jobRows(page).locator("td:nth-child(2)")).toHaveText([
    "공정 데이터 표준 v1 · 1문서 · CSV",
    `공정데이터_A양식 r1 · ${REFERENCE}`,
    "공정데이터_2024_02.xlsx 외 4건",
    `${PROFILE_V1} · 재파싱(rematch)`,
    `${REFERENCE} · ${PROFILE_V1}`,
    REFERENCE,
  ]);
  await expect(jobRows(page).locator("td:nth-child(3) .app-chip")).toHaveText(["완료", "완료", "완료", "완료", "완료", "완료"]);
  await expect(jobRows(page).first().locator("td:nth-child(3) .app-chip")).toHaveClass(/\bok\b/);
  await expect(jobRows(page).locator("td:nth-child(6)")).toHaveText(["행 12개", "완료", "문서 5개", "처리 0건 · 건너뜀 1건", "완료", "문서 1개"]);
  for (const row of await jobRows(page).all()) {
    await expect(row.getByRole("cell").nth(3)).toHaveText(DATETIME_RE);
    await expect(row.getByRole("cell").nth(4)).toHaveText(DATETIME_RE);
    await expect(row.getByRole("button", { name: "이동" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "취소" })).toHaveCount(0);
  }
  await expectNoIds(jobsCard(page));
  // 종류 = 등록 → 2건, 상태 = 실패 → 아직 없음, 필터 해제 → 6건.
  await kindSelect.selectOption("register");
  await expect(page).toHaveURL(/kind=register/);
  await expect(jobRows(page)).toHaveCount(2);
  await expect(jobRows(page).locator("td:nth-child(1)")).toHaveText(["등록", "등록"]);
  await kindSelect.selectOption("");
  await expect(page).not.toHaveURL(/kind=/);
  await stateSelect.selectOption("failed");
  await expect(page).toHaveURL(/state=failed/);
  await expect(jobsCard(page).getByText("아직 작업이 없습니다.")).toBeVisible();
  await expect(jobsTable(page)).toHaveCount(0);
  await stateSelect.selectOption("");
  await expect(jobRows(page)).toHaveCount(6);
  errors.assertClean();
});

test("매핑 검수 전체 승인 → 문서 정상 · 큐 0 · 묶음 처리 작업 행", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoJobs(page, "&queue=review");
  await expectSummary(page, { unmatched: 1, review: 1, failed: 1, changed: 0, conflict: 0 });
  const reviewLabel = `${PROFILE_V1} · 매핑 검수 · 1문서`;
  const reviewRow = groupRow(page, "매핑 검수");
  await expect(reviewRow.getByRole("cell").nth(1).locator("strong")).toHaveText(reviewLabel);

  // 전체 승인: 낙관적으로 행이 빠지고 카드가 0이 되며, 작업이 끝나면 토스트 '처리 1건'.
  await reviewRow.getByRole("button", { name: "전체 승인" }).click();
  await expect(groupTable(page, "매핑 검수")).toHaveCount(0);
  await expect(summaryCards(page).nth(1).locator("strong")).toHaveText("0");
  await expect(toast(page, `매핑 검수 · ${reviewLabel} · 전체 승인 · 처리 1건`).first()).toBeVisible({ timeout: 60_000 });
  await waitForJobs(page);
  await expect(queuePanel(page, "매핑 검수").getByText("매핑 검수 큐가 비어 있습니다.")).toBeVisible();

  // 서버 상태: 양식이동 문서 정상(발행), 큐 0, 값 발행(온도 12건).
  const shifted = (await api(page, "GET", "/documents?q=" + encodeURIComponent(SHIFTED))).json.items[0];
  expect(shifted.status).toBe("normal");
  expect(shifted.profiles[0]).toMatchObject({ profile_name: "공정데이터_A양식", state: "published", compatibility: "compatible" });
  const values = await api(page, "GET", `/snapshots/${shifted.current_snapshot.snapshot_id}/values?rule_key=temperature`);
  expect(values.json.items).toHaveLength(12);
  expect(values.json.items[0].display_text).toBe("150");
  await expectSummary(page, { unmatched: 1, review: 0, failed: 1, changed: 0, conflict: 0 });
  expect((await api(page, "GET", "/status")).json.counts.review).toBe(0);

  // 작업 목록 맨 위: 묶음 처리 · '<묶음> · 일괄 승인' · 완료 · 처리 1건.
  await page.reload();
  await expect(summaryCards(page).nth(1).locator("strong")).toHaveText("0");
  const first = jobRows(page).first();
  await expect(first.getByRole("cell").nth(0)).toHaveText("묶음 처리");
  await expect(first.getByRole("cell").nth(1)).toHaveText(`${reviewLabel} · 일괄 승인`);
  await expect(first.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("완료");
  await expect(first.getByRole("cell").nth(5)).toHaveText("처리 1건");
  const action = (await api(page, "GET", "/jobs?kind=queue_action&limit=1")).json.items[0];
  expect(action).toMatchObject({ state: "succeeded", target_kind: "queue_group", total: 1, completed: 1, result: { queued: 1, skipped: [] } });
  await expectNoIds(page.locator("main"));
  errors.assertClean();
});

test("새 snapshot(변경 감지) 큐 → 동일 승계 전체 승인 → 정상 · 변경 감지 0", async ({ page }) => {
  const errors = collectErrors(page);
  const before = (await api(page, "GET", "/documents?q=" + encodeURIComponent(REFERENCE))).json.items[0];
  const documentId = before.document_id as string;
  const firstSnapshot = before.current_snapshot.snapshot_id as string;
  expect(mutateFirstDocument()).toBe(REFERENCE);
  const job = await registerViaApi(page, [REFERENCE]);
  const registered = job.result.documents[0];
  expect(registered).toMatchObject({ document_id: documentId, status: "changed" });
  expect(registered.snapshot).toMatchObject({ revision_no: 2, unchanged: false });
  expect(registered.applied[0]).toMatchObject({ compatibility: "identical", state: "changed" });
  await waitForJobs(page);

  await gotoJobs(page);
  const queues = await expectSummary(page, { unmatched: 1, review: 0, failed: 1, changed: 1, conflict: 0 });
  await summaryCards(page).nth(3).click();
  await expect(page).toHaveURL(/queue=changed/);
  const changedLabel = `${PROFILE_V1} · 변경 감지 · 1문서`;
  const changedRow = groupRow(page, "변경 감지");
  await expect(changedRow.getByRole("cell").nth(1).locator("strong")).toHaveText(changedLabel);
  await expect(changedRow.getByRole("cell").nth(1)).toContainText(`문서 1개 · 대표 ${REFERENCE}`);
  // 승계 원인은 호환성 라벨(동일/호환)로 표시된다.
  await expect(changedRow.getByRole("cell").nth(2)).toHaveText("새 snapshot 승계 (동일 1 · 호환 0)");
  await expect(changedRow.getByRole("cell").nth(3)).toContainText("규칙 11개");
  await expect(changedRow.getByRole("button", { name: "검수 열기" })).toBeEnabled();
  await expect(changedRow.getByRole("button", { name: "전체 승인" })).toBeEnabled();
  await expect(changedRow.getByRole("button", { name: "프로파일 지정" })).toBeEnabled();
  await changedRow.getByRole("button", { name: `${changedLabel} 멤버 펼치기` }).click();
  const member = memberTable(page, changedLabel).locator("tbody tr");
  await expect(member).toHaveCount(1);
  await expect(member.getByRole("button", { name: REFERENCE, exact: true })).toBeVisible();
  await expect(member.getByRole("cell").nth(1)).toHaveText(DATE_RE);
  await expect(member.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("변경 감지");
  await expect(member.getByRole("cell").nth(2).locator(".app-chip")).toHaveClass(/\bwarn\b/);
  await expect(member.getByRole("button", { name: "원본 보기" })).toBeEnabled();
  const members = await api(page, "GET", `/queues/changed/groups/${queues.groups.changed[0].group_key}/members`);
  expect(members.json.items[0]).toMatchObject({ document_name: REFERENCE, compatibility: "identical", state: "changed", document_status: "changed", application_state: "changed" });
  expect(members.json.items[0].snapshot).toMatchObject({ revision_no: 2, snapshot_id: registered.snapshot.snapshot_id });
  // 검수 열기 → Source Review overlay(대표 문서의 application) → 돌아가기.
  const changedApplication = queues.groups.changed[0].representative.application_id as string;
  await changedRow.getByRole("button", { name: "검수 열기" }).click();
  await expect(page).toHaveURL(new RegExp(`review=${changedApplication}`));
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(review.locator("strong").first()).toHaveText(REFERENCE);
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).toHaveURL(/queue=changed/);

  // 전체 승인(동일 승계만 허용) → 정상 · 발행, 변경 감지 0.
  await groupRow(page, "변경 감지").getByRole("button", { name: "전체 승인" }).click();
  await expect(summaryCards(page).nth(3).locator("strong")).toHaveText("0");
  await expect(toast(page, `변경 감지 · ${changedLabel} · 전체 승인 · 처리 1건`).first()).toBeVisible({ timeout: 60_000 });
  await waitForJobs(page);
  await expect(queuePanel(page, "변경 감지").getByText("변경 감지 큐가 비어 있습니다.")).toBeVisible();
  const after = (await api(page, "GET", "/documents/" + documentId)).json;
  expect(after.status).toBe("normal");
  expect(after.current_snapshot).toMatchObject({ revision_no: 2 });
  expect(after.current_snapshot.snapshot_id).not.toBe(firstSnapshot);
  expect(after.profiles[0]).toMatchObject({ state: "published", compatibility: "identical" });
  const values = await api(page, "GET", `/snapshots/${after.current_snapshot.snapshot_id}/values?rule_key=temperature`);
  expect(values.json.items).toHaveLength(12);
  expect(values.json.items[0].display_text).toBe("150.5");
  await expectSummary(page, { unmatched: 1, review: 0, failed: 1, changed: 0, conflict: 0 });
  await page.reload();
  const first = jobRows(page).first();
  await expect(first.getByRole("cell").nth(0)).toHaveText("묶음 처리");
  await expect(first.getByRole("cell").nth(1)).toHaveText(`${changedLabel} · 일괄 승인`);
  await expect(first.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("완료");
  await expect(first.getByRole("cell").nth(5)).toHaveText("처리 1건");
  errors.assertClean();
});

test("실패한 등록 작업 행(오류 문구 · 이동 → 문서 드로어) · 재파싱이 도는 동안 JobBar '진행 중 작업'", async ({ page }) => {
  const errors = collectErrors(page);
  // 잠긴 문서를 같은 문서로 다시 등록 → 등록 작업 실패(DRM), target은 그 문서.
  const lockedId = (await api(page, "GET", "/documents?status=locked")).json.items[0].document_id as string;
  const failed = await api(page, "POST", "/documents/register?wait=30", { source_refs: [LOCKED], provider: "local-xlsx", document_id: lockedId });
  expect(failed.status).toBeLessThan(300);
  expect(failed.json).toMatchObject({ kind: "register", state: "failed", error_code: "DRM_READER_REQUIRED", error_message: DRM_MESSAGE, target_kind: "document", target_id: lockedId, label: LOCKED });

  await gotoJobs(page, "&state=failed");
  await expect(jobsCard(page).getByLabel("상태")).toHaveValue("failed");
  await expect(jobRows(page)).toHaveCount(1);
  const row = jobRows(page).first();
  await expect(row).toHaveClass(/\bapp-job-failed\b/);
  await expect(row.getByRole("cell").nth(0)).toHaveText("등록");
  await expect(row.getByRole("cell").nth(1)).toHaveText(LOCKED);
  await expect(row.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("실패");
  await expect(row.getByRole("cell").nth(2).locator(".app-chip")).toHaveClass(/\berr\b/);
  await expect(row.locator(".app-error-text")).toHaveText(DRM_MESSAGE);
  await row.getByRole("button", { name: "이동" }).click();
  await expect(page).toHaveURL(/screen=documents/);
  await expect(page).toHaveURL(new RegExp(`document=${lockedId}`));
  const detail = page.getByRole("dialog", { name: "문서 상세" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: LOCKED, exact: true })).toBeVisible();
  await expect(detail.locator(".app-modal-head .app-chip").first()).toHaveText("잠김(DRM)");
  await expect(detail.getByRole("alert")).toHaveText("최근 오류: " + DRM_MESSAGE);
  await detail.press("Escape");
  await expect(detail).toHaveCount(0);

  // 재파싱이 도는 동안 JobBar: Reader가 열 때마다 수 초 걸리는 compatible 문서를 등록해 두고(검수 대기),
  // 재파싱(rematch)을 wait 없이 요청한 직후 화면을 열면 진행 중 작업이 보인다.
  expect(writeHeavyDocument()).toBe(HEAVY);
  const heavy = await registerViaApi(page, [HEAVY]);
  expect(heavy.result.documents[0]).toMatchObject({ document_name: HEAVY, status: "review" });
  expect(heavy.result.documents[0].applied[0]).toMatchObject({ compatibility: "compatible", state: "review" });
  await waitForJobs(page);
  const profileId = (await api(page, "GET", "/profiles")).json.items[0].profile_id as string;
  const started = await api(page, "POST", `/profiles/${profileId}/reparse`, { mode: "rematch" });
  expect(started.status).toBe(202);
  expect(["queued", "running"]).toContain(started.json.state);
  expect(started.json).toMatchObject({ kind: "reparse", target_kind: "profile", target_id: profileId, label: `${PROFILE_V1} · 재파싱(rematch)` });
  await page.goto("/?screen=jobs");
  const jobBar = page.locator(".app-jobbar");
  await expect(jobBar).toBeVisible();
  await expect(jobBar).toHaveText(/진행 중 작업 [1-9]/);
  await expect(jobBar.getByRole("button", { name: "보기" })).toBeVisible();
  await expect(page.getByRole("status", { name: "렌더 서버 상태" })).toContainText(/진행 중 작업 [1-9]/);
  const running = jobRows(page).first();
  await expect(running.getByRole("cell").nth(0)).toHaveText("재파싱");
  await expect(running.getByRole("cell").nth(1)).toHaveText(`${PROFILE_V1} · 재파싱(rematch)`);
  await expect(running.getByRole("cell").nth(2).locator(".app-chip")).toHaveText(/^(진행 중|대기)/);
  await expect(running.getByRole("button", { name: "취소" })).toBeVisible();
  // 작업이 끝나면 JobBar가 사라지고 행은 완료 + 건너뜀 요약(대용량 문서는 검수 필요라 건너뜀).
  await expect
    .poll(async () => (await api(page, "GET", "/jobs/" + started.json.job_id)).json.state, { timeout: 120_000, message: "재파싱 작업이 끝나야 한다" })
    .toBe("succeeded");
  const finished = (await api(page, "GET", "/jobs/" + started.json.job_id)).json;
  expect(finished.result.queued).toBe(0);
  expect(finished.result.skipped.map((s: { document_name: string; reason: string }) => [s.document_name, s.reason])).toContainEqual([HEAVY, "review_required"]);
  await expect(jobBar).toHaveCount(0);
  await expect(running.getByRole("cell").nth(2).locator(".app-chip")).toHaveText("완료");
  await expect(running.getByRole("cell").nth(5)).toHaveText(`처리 0건 · 건너뜀 ${finished.result.skipped.length}건`);
  await expect(running.getByRole("button", { name: "취소" })).toHaveCount(0);
  await expect(page.getByRole("status", { name: "렌더 서버 상태" })).not.toContainText("진행 중 작업");
  expect((await api(page, "GET", "/jobs?state=running")).json.items).toHaveLength(0);
  await expectNoIds(page.locator("main"));
  errors.assertClean();
});
