// 폴더 일괄 등록 E2E(계약 §8 register-directory.spec, §4.1.1): 파일을 하나씩 고르지 않고 루트 폴더 하나를 지정하면
// 그 아래(하위 폴더 포함) 전부가 등록된다. 원본 폴더에 `일괄/2024/`·`일괄/2024/하위/` 트리를 만들고
// (같은 양식 복사본 3 + 다른 양식 1 + `~$임시.xlsx` + `메모.txt`) 미리보기 → 등록 → 재스캔(변경 없음) →
// 다시 읽기 → 값 변경(변경 감지)까지 한 흐름으로 확인한다. 두 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false).
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, makeRawTree, mutateRawDocument, resetWorkspace, waitForJobs } from "./helpers";

const BATCH = "일괄"; // 사용자가 UI에서 지정하는 루트 폴더
const COPIES = ["공정A_01.xlsx", "공정A_02.xlsx", "공정A_03.xlsx"]; // 같은 양식(A양식) 복사본 3개
const OTHER_COPY = "품질검사_사본.xlsx"; // 다른 양식 → 프로파일 없음
const CHANGED_REF = `${BATCH}/2024/공정A_01.xlsx`; // 값을 바꿀 복사본(원본 폴더 기준 상대 경로)
const PROFILE_V1 = "공정데이터_A양식 v1";
const JOB_LABEL = `${BATCH} 폴더 일괄 등록`; // §4.1.1 label

const documentsTable = (page: Page) => page.getByRole("table", { name: "문서 목록" });
const rowOf = (page: Page, name: string) => documentsTable(page).getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
const statusChip = (page: Page, name: string) => rowOf(page, name).getByRole("cell").nth(2).locator(".v3-chip");
const dialogOf = (page: Page) => page.getByRole("dialog", { name: "문서 등록" });

// `일괄/2024/`(같은 양식 2 + 다른 양식 1 + 임시 파일 + 메모) · `일괄/2024/하위/`(같은 양식 1).
// 대상 파일 4개 · 하위 폴더 2개 · 건너뜀 임시 1 · 지원하지 않는 파일 1.
function buildBatchTree(): void {
  makeRawTree([
    { path: `${BATCH}/2024/${COPIES[0]}`, copyFrom: "공정데이터_2024_02.xlsx" },
    { path: `${BATCH}/2024/${COPIES[1]}`, copyFrom: "공정데이터_2024_02.xlsx" },
    { path: `${BATCH}/2024/${OTHER_COPY}`, copyFrom: "품질검사_2024_05.xlsx" },
    { path: `${BATCH}/2024/하위/${COPIES[2]}`, copyFrom: "공정데이터_2024_01.xlsx" },
    { path: `${BATCH}/2024/~$임시.xlsx`, text: "임시 파일" },
    { path: `${BATCH}/2024/메모.txt`, text: "메모" },
  ]);
}

// 등록 대화상자를 열고 최상위 원본 파일 목록까지 그린다.
async function openRegister(page: Page) {
  await page.getByRole("button", { name: "+ 문서 등록" }).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("table", { name: "원본 파일 목록" })).toBeVisible();
  return dialog;
}

async function gotoDocuments(page: Page) {
  await page.goto("/?screen=documents");
  await expect(documentsTable(page)).toBeVisible();
}

test.beforeAll(async () => {
  await resetWorkspace();
});

test("폴더 일괄 등록: 미리보기 → 4개 등록 → 재스캔(변경 없음) → 다시 읽기 → 값 변경(변경 감지)", async ({ page }) => {
  const errors = collectErrors(page);
  buildBatchTree();
  await gotoDocuments(page);
  await expect(documentsTable(page).getByRole("row")).toHaveCount(7); // 헤더 + 시드 6

  // ---- 미리보기: `일괄` 폴더로 들어가 '이 폴더 전체 등록'(Reader 없이 stat·해시 캐시만 쓰므로 빠르다)
  let dialog = await openRegister(page);
  await expect(dialog.getByRole("table", { name: "원본 파일 목록" }).getByRole("row")).toHaveCount(8); // 헤더 + 시드 6 + 폴더 1
  await dialog.getByRole("button", { name: `📁 ${BATCH}` }).click();
  await expect(dialog.getByRole("button", { name: "📁 2024" })).toBeVisible();
  await dialog.getByRole("button", { name: "이 폴더 전체 등록" }).click();
  await expect(dialog.getByText(`${BATCH}/ 아래 파일 4개 · 하위 폴더 2개`)).toBeVisible();
  const chips = dialog.getByLabel("스캔 요약");
  await expect(chips).toContainText("새 파일 4");
  await expect(chips).toContainText("변경된 문서 0");
  await expect(chips).toContainText("변경 없음 0");
  await expect(chips).toContainText("잠김 0");
  await expect(dialog.getByText("건너뜀: 임시 파일 1 · 지원하지 않는 파일 1")).toBeVisible();
  await expect(dialog.getByLabel("변경 없는 문서·잠긴 문서도 다시 읽기")).not.toBeChecked();

  // ---- 등록: '4개 등록 시작' → 요약 + 파일별 결과(정상 3 · 프로파일 없음 1)
  await dialog.getByRole("button", { name: "4개 등록 시작" }).click();
  const results = dialog.getByRole("table", { name: "등록 결과" });
  await expect(results).toBeVisible({ timeout: 180_000 });
  await expect(dialog.getByText("4개 중 4개 등록 · 0개 변경 없음 · 0개 실패")).toBeVisible();
  await expect(results.getByRole("row")).toHaveCount(5); // 헤더 + 4
  for (const name of COPIES) {
    const row = results.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("cell").nth(1)).toHaveText("완료");
    await expect(row.getByRole("cell").nth(2)).toHaveText("공정데이터_A양식 · 동일");
    await expect(row.getByRole("cell").nth(3)).toHaveText("정상");
    await expect(row.getByRole("cell").nth(4)).toHaveText("");
  }
  const otherRow = results.getByRole("row").filter({ hasText: OTHER_COPY });
  await expect(otherRow.getByRole("cell").nth(1)).toHaveText("완료");
  await expect(otherRow.getByRole("cell").nth(2)).toHaveText("없음");
  await expect(otherRow.getByRole("cell").nth(3)).toHaveText("프로파일 없음");
  await expect(dialog.getByText(/앞 500개만 표시/)).toHaveCount(0);
  // 미리보기·진행·결과 어디에도 내부 ID를 보이지 않는다(§7 표시 규칙).
  expect(await dialog.innerText()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

  // ---- 문서 목록: 하위 폴더 파일까지 4건이 늘었다
  await dialog.locator("button.primary", { hasText: "닫기" }).click();
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(documentsTable(page).getByRole("row")).toHaveCount(11); // 헤더 + 시드 6 + 4
  for (const name of COPIES) {
    await expect(statusChip(page, name)).toHaveText("정상");
    await expect(rowOf(page, name).getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  }
  await expect(statusChip(page, OTHER_COPY)).toHaveText("프로파일 없음");
  await waitForJobs(page);
  // 재스캔은 등록된 4건을 전부 '변경 없음'으로 본다(§1.6 source_digest가 따뜻하다 — 파일을 다시 읽지 않는다).
  const scanned = await api(page, "GET", "/sources/scan?directory=" + encodeURIComponent(BATCH));
  expect(scanned.status).toBe(200);
  expect(scanned.json).toMatchObject({
    directory: BATCH,
    folders: 2,
    files: 4,
    targeted: 0,
    states: { new: 0, changed: 0, unchanged: 4, locked: 0 },
    skipped: { temp: 1, unsupported: 1, symlink: 0 },
  });

  // ---- 재스캔: 변경 없음 4 · 시작 비활성(같은 폴더를 다시 돌려도 싸다)
  dialog = await openRegister(page);
  await dialog.getByRole("button", { name: `${BATCH} 전체 등록` }).click(); // 폴더 행의 버튼(폴더를 열지 않는다)
  await expect(dialog.getByText(`${BATCH}/ 아래 파일 4개 · 하위 폴더 2개`)).toBeVisible();
  await expect(dialog.getByLabel("스캔 요약")).toContainText("변경 없음 4");
  await expect(dialog.getByLabel("스캔 요약")).toContainText("새 파일 0");
  const start = dialog.getByRole("button", { name: /등록 시작/ });
  await expect(start).toHaveText("0개 등록 시작");
  await expect(start).toBeDisabled();
  await expect(dialog.getByText("등록할 새 파일이나 변경된 문서가 없습니다.")).toBeVisible();

  // ---- 체크박스: 변경 없는 문서도 다시 읽기 → 4개 재읽기(문서는 늘지 않는다)
  await dialog.getByLabel("변경 없는 문서·잠긴 문서도 다시 읽기").check();
  await expect(start).toHaveText("4개 등록 시작");
  await start.click();
  await expect(dialog.getByRole("table", { name: "등록 결과" })).toBeVisible({ timeout: 180_000 });
  await expect(dialog.getByText("4개 중 4개 등록 · 4개 변경 없음 · 0개 실패")).toBeVisible();
  await dialog.locator("button.primary", { hasText: "닫기" }).click();
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(documentsTable(page).getByRole("row")).toHaveCount(11);
  await waitForJobs(page);

  // ---- 값 변경: 스캔이 '변경된 문서 1'로 잡고, 등록하면 변경 감지(승계 proposed)
  expect(mutateRawDocument(CHANGED_REF)).toBe(CHANGED_REF);
  dialog = await openRegister(page);
  await dialog.getByRole("button", { name: `${BATCH} 전체 등록` }).click();
  await expect(dialog.getByLabel("스캔 요약")).toContainText("변경된 문서 1");
  await expect(dialog.getByLabel("스캔 요약")).toContainText("변경 없음 3");
  await expect(dialog.getByRole("button", { name: /등록 시작/ })).toHaveText("1개 등록 시작");
  await dialog.getByRole("button", { name: "1개 등록 시작" }).click();
  const changedResults = dialog.getByRole("table", { name: "등록 결과" });
  await expect(changedResults).toBeVisible({ timeout: 180_000 });
  await expect(dialog.getByText("1개 중 1개 등록 · 3개 변경 없음 · 0개 실패")).toBeVisible();
  await expect(changedResults.getByRole("row")).toHaveCount(2); // 헤더 + 1
  const changedRow = changedResults.getByRole("row").filter({ hasText: COPIES[0] });
  await expect(changedRow.getByRole("cell").nth(1)).toHaveText("완료");
  await expect(changedRow.getByRole("cell").nth(3)).toHaveText("변경 감지");
  await dialog.locator("button.primary", { hasText: "닫기" }).click();
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(statusChip(page, COPIES[0])).toHaveText("변경 감지");
  await expect(statusChip(page, COPIES[1])).toHaveText("정상");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(11);
  await waitForJobs(page);

  errors.assertClean();
});

test("API: 폴더 경로 검증(422 INVALID_SOURCE · 404) · 작업 라벨", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoDocuments(page);
  // `..`·절대 경로는 스캔도 등록도 거부한다(§4.1.1 정규화).
  for (const directory of ["..", `${BATCH}/../..`, "/etc"]) {
    const scan = await api(page, "GET", "/sources/scan?directory=" + encodeURIComponent(directory));
    expect(scan.status, `스캔 ${directory}`).toBe(422);
    expect(scan.json.error.code).toBe("INVALID_SOURCE");
    const job = await api(page, "POST", "/documents/register-directory?wait=10", { directory, provider: "local-xlsx", include_unchanged: false });
    expect(job.status, `등록 ${directory}`).toBe(422);
    expect(job.json.error.code).toBe("INVALID_SOURCE");
  }
  const missing = await api(page, "GET", "/sources/scan?directory=" + encodeURIComponent("없는폴더"));
  expect(missing.status).toBe(404);
  expect(missing.json.error.code).toBe("SOURCE_NOT_FOUND");
  // 알 수 없는 provider는 작업을 만들기 전에 막는다(§4.1 UNKNOWN_PROVIDER) — 잠긴 문서 행을 양산하지 않는다.
  const unknown = await api(page, "POST", "/documents/register-directory?wait=10", { directory: BATCH, provider: "unknown-provider", include_unchanged: false });
  expect(unknown.status).toBe(422);
  expect(unknown.json.error.code).toBe("UNKNOWN_PROVIDER");

  // 작업 내역: 마지막 등록 작업은 폴더 일괄 등록이다(§4.1.1 label, 오류 요청은 작업을 만들지 않았다).
  const jobs = await api(page, "GET", "/jobs?kind=register");
  expect(jobs.status).toBe(200);
  expect(jobs.json.items[0]).toMatchObject({ kind: "register", state: "succeeded", label: JOB_LABEL, target_kind: "workspace" });
  expect(jobs.json.items.filter((item: { label: string | null }) => item.label === JOB_LABEL)).toHaveLength(3);

  // 오류 응답이 문서를 만들지 않았다.
  await expect(documentsTable(page).getByRole("row")).toHaveCount(11);
  errors.assertClean();
});
