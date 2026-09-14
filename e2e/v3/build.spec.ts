// 데이터 빌드 E2E(계약 §8 build.spec): 문서 3개 인계 → candidates(제외 사유) → 스키마(필드별 값 있는 문서 수) → 출력 Header 편집
// (중복·빈 값 오류, ↑ 순서 변경) → 미리보기(원본 보기 → Source Review overlay) → CSV/XLSX/SQLite 생성·다운로드 내용 검사 →
// manifest → build_key 재사용 → 새 빌드. 한 test()가 순서대로 진행한다. 모든 단언은 실제 표시 문구·다운로드 파일 내용을 본다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, openScreen, readCsv, readXlsxHeaders, resetWorkspace, runPython, sqliteRow } from "./helpers";

const USABLE = ["공정데이터_2024_01.xlsx", "공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"];
const OTHER = "품질검사_2024_05.xlsx";
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const PROFILE_V1 = "공정데이터_A양식 v1";
const SCHEMA_KEY = "process_standard";
const SCHEMA_NAME = "공정 데이터 표준";
const LOT_COUNT = 12; // 시드 문서마다 LOT 표 12행(examples/schema_v3/demo.py)
// 스키마 ordinal 순, group 필드 제외(kg/v3/build.py _fields).
const FIELDS: [string, string][] = [
  ["product_name", "제품명"],
  ["recipe_name", "레시피명"],
  ["process_name", "공정명"],
  ["equipment", "설비명"],
  ["lot", "배치"],
  ["measured_at", "측정일시"],
  ["temperature", "온도"],
  ["pressure", "압력"],
  ["duration", "시간"],
  ["result_value", "결과값"],
  ["verdict", "판정"],
];
// 온도를 ↑로 한 칸 올리고 온도·압력 Header를 바꾼 뒤 기대하는 출력 순서.
const EXPECTED_HEADERS = ["제품명", "레시피명", "공정명", "설비명", "배치", "온도_C", "측정일시", "압력_bar", "시간", "결과값", "판정"];
const EXPECTED_FIELD_ORDER = ["product_name", "recipe_name", "process_name", "equipment", "lot", "temperature", "measured_at", "pressure", "duration", "result_value", "verdict"];
const META_COLUMNS = ["_document", "_snapshot", "_record_key"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

type PreviewCell = { text: string; sheet_id: string | null; sheet_name: string | null; range: string | null; application_id: string | null; rule_key: string | null } | null;
type Preview = { columns: { field_key: string; header: string }[]; rows: { row_no: number; record_key: string | null; document: { document_name: string }; cells: PreviewCell[] }[]; row_count: number; excluded: unknown[]; conflicts: unknown[] };
type BuildResponse = { build_key: string; download_url: string; reused: boolean; manifest: { row_count: number; columns: unknown[]; sources: unknown[] } };

const documentsTable = (page: Page) => page.getByRole("table", { name: "문서 목록" });
const targets = (page: Page) => page.getByRole("table", { name: "대상 문서" });
const targetRow = (page: Page, name: string) => targets(page).getByRole("row").filter({ hasText: name });
const stepper = (page: Page) => page.getByRole("navigation", { name: "빌드 단계" });
const columnsTable = (page: Page) => page.getByRole("table", { name: "출력 컬럼 설정" });
const headerInput = (page: Page, name: string) => columnsTable(page).getByRole("textbox", { name: `${name} 출력 Header` });

// 문서 화면에서 문서를 골라 '데이터 빌드에 추가'하고 토스트로 데이터 빌드 화면에 간다.
async function addDocumentsToBuild(page: Page, names: string[]) {
  await openScreen(page, "문서");
  await expect(documentsTable(page).getByRole("row")).toHaveCount(7);
  for (const name of names) await page.getByRole("checkbox", { name: `${name} 선택` }).check();
  const selection = page.getByRole("region", { name: "선택한 문서" });
  await expect(selection).toContainText(`${names.length}개 선택`);
  await selection.getByRole("button", { name: "데이터 빌드에 추가" }).click();
  const toast = page.locator(".v3-toast").filter({ hasText: `${names.length}개 문서 · 데이터 빌드로 이동 ›` });
  await expect(toast).toBeVisible();
  await expect(selection).toHaveCount(0);
  await toast.getByRole("button", { name: "데이터 빌드로 이동" }).click();
  await expect(page).toHaveURL(/screen=build/);
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "데이터 빌드" })).toHaveAttribute("aria-current", "page");
}

// 스텝퍼 버튼의 접근 가능한 이름은 CSS ::before(단계 번호) + 라벨이므로 부분 일치로 찾는다.
async function expectStep(page: Page, label: string) {
  await expect(stepper(page).getByRole("button", { name: label })).toHaveAttribute("aria-current", "step");
}

// '파일 생성' 또는 '다시 생성'을 눌러 POST /builds 응답(JSON)을 돌려준다.
async function generate(page: Page, buttonName: string): Promise<BuildResponse> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/v3/builds?") || r.url().endsWith("/api/v3/builds")),
    page.getByRole("button", { name: buttonName, exact: true }).click(),
  ]);
  expect(response.request().method()).toBe("POST");
  expect(response.status(), "동기 빌드는 200이어야 한다").toBe(200);
  return (await response.json()) as BuildResponse;
}

// 결과 카드의 '다운로드'를 눌러 파일을 저장하고 경로를 돌려준다.
async function downloadResult(page: Page, saveAs: string): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("region", { name: "빌드 결과" }).getByRole("button", { name: "다운로드" }).click()]);
  const path = test.info().outputPath(saveAs);
  await download.saveAs(path);
  return path;
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("문서 인계 · 제외 사유 · 스키마 · 출력 Header 편집 · 미리보기/원본 보기 · CSV/XLSX/SQLite · manifest · 새 빌드", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?screen=documents");

  // ---- 1단계: 문서 3개 인계 → 입력 문서 3개 · 사용 가능 3개 · 제외 0개.
  await addDocumentsToBuild(page, USABLE);
  await expect(page.getByRole("heading", { level: 1, name: "데이터 빌드" })).toBeVisible();
  await expect(stepper(page).getByRole("button")).toHaveText(["대상 문서", "스키마", "출력 설정", "미리보기", "생성"]);
  await expectStep(page, "대상 문서");
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서/ })).toHaveText("입력 문서 3개 · 사용 가능 3개 · 제외 0개");
  await expect(targets(page).locator("tbody tr")).toHaveCount(3);
  for (const name of USABLE) {
    const row = targetRow(page, name);
    await expect(row.getByRole("cell").nth(1).locator(".v3-chip")).toHaveText("사용 가능");
    await expect(row.getByRole("cell").nth(1).locator(".v3-chip")).toHaveClass(/\bok\b/);
    await expect(row.getByRole("cell").nth(2)).toHaveText("");
    await expect(row.getByRole("cell").nth(3)).toHaveText(PROFILE_V1);
  }
  await expect(page.getByRole("button", { name: "다음: 스키마" })).toBeEnabled();
  expect(page.url()).not.toMatch(UUID);

  // 프로파일 없음·검수 필요 문서를 더하면 제외 사유(BUILD_REASON_LABELS)와 함께 표시되고 '다음'은 여전히 가능하다.
  await page.getByRole("button", { name: "문서 다시 선택" }).click();
  await addDocumentsToBuild(page, [OTHER, SHIFTED]);
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서/ })).toHaveText("입력 문서 5개 · 사용 가능 3개 · 제외 2개");
  await expect(targets(page).locator("tbody tr")).toHaveCount(5);
  const otherRow = targetRow(page, OTHER);
  await expect(otherRow.getByRole("cell").nth(1).locator(".v3-chip")).toHaveText("제외");
  await expect(otherRow.getByRole("cell").nth(1).locator(".v3-chip")).toHaveClass(/\bmuted\b/);
  await expect(otherRow.getByRole("cell").nth(2)).toHaveText("프로파일 없음");
  await expect(otherRow.getByRole("cell").nth(3)).toHaveText("-");
  const shiftedRow = targetRow(page, SHIFTED);
  await expect(shiftedRow.getByRole("cell").nth(1).locator(".v3-chip")).toHaveText("제외");
  await expect(shiftedRow.getByRole("cell").nth(2)).toHaveText("검수 필요");
  await expect(shiftedRow.getByRole("cell").nth(3)).toHaveText("-");
  const draft5 = await page.evaluate(() => JSON.parse(sessionStorage.getItem("v3.build.draft") || "null"));
  expect(draft5?.document_ids).toHaveLength(5);
  const candidates = await api(page, "POST", "/builds/candidates", { document_ids: draft5.document_ids });
  expect(candidates.status).toBe(200);
  expect(candidates.json.summary).toEqual({ total: 5, usable: 3, excluded: 2 });
  expect(candidates.json.documents.find((d: { document_name: string }) => d.document_name === OTHER)).toMatchObject({ usable: false, reason: "unmatched" });
  expect(candidates.json.documents.find((d: { document_name: string }) => d.document_name === SHIFTED)).toMatchObject({ usable: false, reason: "review_required" });

  // 제거 → 다시 3개.
  await otherRow.getByRole("button", { name: `${OTHER} 제거` }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서/ })).toHaveText("입력 문서 4개 · 사용 가능 3개 · 제외 1개");
  await expect(targetRow(page, OTHER)).toHaveCount(0);
  await shiftedRow.getByRole("button", { name: `${SHIFTED} 제거` }).click();
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서/ })).toHaveText("입력 문서 3개 · 사용 가능 3개 · 제외 0개");
  await expect(targets(page).locator("tbody tr")).toHaveCount(3);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem("v3.build.draft") || "null"));
  expect(draft?.document_ids).toHaveLength(3);
  const documentIds: string[] = draft.document_ids;
  // 이후 단계는 이동 불가(스텝퍼 비활성).
  await expect(stepper(page).getByRole("button", { name: "출력 설정" })).toBeDisabled();
  await expect(stepper(page).getByRole("button", { name: "미리보기" })).toBeDisabled();

  // ---- 2단계: 스키마 선택 → 필드 11개 · 값 있는 문서 수 3.
  await page.getByRole("button", { name: "다음: 스키마" }).click();
  await expect(page).toHaveURL(/step=2/);
  await expectStep(page, "스키마");
  await expect(page.getByRole("heading", { level: 2, name: "파싱 스키마 선택" })).toBeVisible();
  const schemaSelect = page.getByRole("combobox", { name: "파싱 스키마" });
  const schemas = await api(page, "GET", "/schemas");
  const schemaRow = schemas.json.items.find((s: { schema_key: string }) => s.schema_key === SCHEMA_KEY);
  expect(schemaRow).toBeTruthy();
  await expect(schemaSelect.locator("option")).toHaveText([
    "선택하세요",
    `${SCHEMA_NAME} v${schemaRow.current_rev} · 필드 ${schemaRow.field_count}개 · 프로파일 ${schemaRow.profile_count}개 · 문서 ${schemaRow.document_count}개`,
  ]);
  await expect(page.getByRole("button", { name: "다음: 출력 설정" })).toBeDisabled();
  await schemaSelect.selectOption(SCHEMA_KEY);
  await expect(page.getByText(`필드 ${FIELDS.length}개 · 값 있는 문서 수`)).toBeVisible();
  const fieldChips = page.locator('[aria-label="필드 목록"] .v3-chip');
  await expect(fieldChips).toHaveText(FIELDS.map(([, name]) => `${name} · 3`));
  await expect(fieldChips.first()).toHaveClass(/\bblue\b/);
  await expect(fieldChips.filter({ hasText: "온도" })).toHaveAttribute("title", "단위 °C");
  await expect(page.getByRole("button", { name: "다음: 출력 설정" })).toBeEnabled();

  // ---- 3단계: 출력 Header 편집.
  await page.getByRole("button", { name: "다음: 출력 설정" }).click();
  await expect(page).toHaveURL(/step=3/);
  await expectStep(page, "출력 설정");
  await expect(page.getByRole("heading", { level: 2, name: "출력 컬럼 설정" })).toBeVisible();
  const columnRows = columnsTable(page).locator("tbody tr");
  await expect(columnRows).toHaveCount(FIELDS.length);
  expect(await columnRows.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-field")))).toEqual(FIELDS.map(([key]) => key));
  await expect(columnsTable(page).getByRole("columnheader")).toHaveText(["사용", "원본 Field", "출력 Header", "Type", "Unit", "값 있는 문서", "순서"]);
  await expect(page.getByText(`사용 ${FIELDS.length}/${FIELDS.length}개`)).toBeVisible();
  const tempRow = columnsTable(page).locator('tbody tr[data-field="temperature"]');
  await expect(tempRow.getByRole("cell").nth(1)).toContainText("온도");
  await expect(tempRow.getByRole("cell").nth(1)).toContainText("temperature");
  await expect(tempRow.getByRole("cell").nth(3)).toHaveText("decimal");
  await expect(tempRow.getByRole("cell").nth(4)).toHaveText("°C");
  await expect(tempRow.getByRole("cell").nth(5)).toHaveText("3/3");
  await expect(columnsTable(page).locator('tbody tr[data-field="pressure"]').getByRole("cell").nth(4)).toHaveText("bar");
  for (const [, name] of FIELDS) {
    await expect(headerInput(page, name)).toHaveValue(name); // 기본값 = 필드명
    await expect(columnsTable(page).getByRole("checkbox", { name: `${name} 사용` })).toBeChecked();
  }
  const nextPreview = page.getByRole("button", { name: "다음: 미리보기" });
  await expect(nextPreview).toBeEnabled();

  // 온도 → 온도_C, 압력 → 온도_C(중복) → 두 입력 모두 오류 + 다음 비활성.
  await headerInput(page, "온도").fill("온도_C");
  await expect(nextPreview).toBeEnabled();
  await headerInput(page, "압력").fill("온도_C");
  await expect(headerInput(page, "압력")).toHaveAttribute("aria-invalid", "true");
  await expect(headerInput(page, "온도")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#v3-build-header-error-pressure")).toHaveText("중복된 출력 Header입니다.");
  await expect(page.locator("#v3-build-header-error-temperature")).toHaveText("중복된 출력 Header입니다.");
  await expect(page.getByText("오류 2건")).toBeVisible();
  await expect(nextPreview).toBeDisabled();
  await expect(stepper(page).getByRole("button", { name: "미리보기" })).toBeDisabled();
  await headerInput(page, "압력").fill("압력_bar");
  await expect(headerInput(page, "압력")).not.toHaveAttribute("aria-invalid", "true");
  await expect(headerInput(page, "온도")).not.toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".v3-inline-error")).toHaveCount(0);
  await expect(nextPreview).toBeEnabled();

  // 빈 값 오류 → 되돌리면 해제.
  await headerInput(page, "시간").fill("   ");
  await expect(page.locator("#v3-build-header-error-duration")).toHaveText("출력 Header를 입력하세요.");
  await expect(headerInput(page, "시간")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("오류 1건")).toBeVisible();
  await expect(nextPreview).toBeDisabled();
  await headerInput(page, "시간").fill("시간");
  await expect(page.locator(".v3-inline-error")).toHaveCount(0);
  await expect(nextPreview).toBeEnabled();

  // 온도를 ↑로 한 칸(측정일시 앞으로). 첫 행의 ↑와 마지막 행의 ↓는 비활성.
  await expect(columnsTable(page).getByRole("button", { name: "제품명 위로" })).toBeDisabled();
  await expect(columnsTable(page).getByRole("button", { name: "판정 아래로" })).toBeDisabled();
  await columnsTable(page).getByRole("button", { name: "온도 위로" }).click();
  await expect
    .poll(async () => columnRows.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-field"))))
    .toEqual(EXPECTED_FIELD_ORDER);
  await expect(headerInput(page, "온도")).toHaveValue("온도_C");
  // 출력 설정은 세션 저장소(v3.build.columns)에 남는다.
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem("v3.build.columns") || "null"));
  expect(saved?.schema_key).toBe(SCHEMA_KEY);
  expect(saved?.row_mode).toBe("record");
  expect(saved?.columns.map((c: { field_key: string }) => c.field_key)).toEqual(EXPECTED_FIELD_ORDER);
  expect(saved?.columns.map((c: { header: string }) => c.header)).toEqual(EXPECTED_HEADERS);
  await expect(page.getByRole("combobox", { name: "행 구성" })).toHaveValue("record");

  // ---- 4단계: 미리보기(POST /builds/preview와 같은 입력으로 API 기대값을 만든다).
  const input = { document_ids: documentIds, schema_key: SCHEMA_KEY, columns: EXPECTED_FIELD_ORDER.map((field_key, i) => ({ field_key, header: EXPECTED_HEADERS[i] })), row_mode: "record" };
  const expectedPreview = await api<Preview>(page, "POST", "/builds/preview", input);
  expect(expectedPreview.status).toBe(200);
  expect(expectedPreview.json.row_count).toBe(USABLE.length * LOT_COUNT);
  const rowCount = expectedPreview.json.row_count;
  expect(expectedPreview.json.rows).toHaveLength(Math.min(rowCount, 50));
  expect(expectedPreview.json.columns.map((c) => c.header)).toEqual(EXPECTED_HEADERS);
  expect(expectedPreview.json.excluded).toEqual([]);

  await nextPreview.click();
  await expect(page).toHaveURL(/step=4/);
  await expectStep(page, "미리보기");
  await expect(page.getByRole("heading", { level: 2, name: "미리보기" })).toBeVisible();
  const preview = page.getByRole("table", { name: "미리보기" });
  await expect(preview).toBeVisible();
  await expect(page.getByText(`총 ${rowCount}행 · 표시 ${Math.min(rowCount, 50)}행(최대 50행)`)).toBeVisible();
  await expect(preview.getByRole("columnheader")).toHaveText(["#", ...EXPECTED_HEADERS]);
  await expect(preview.locator("tbody tr")).toHaveCount(Math.min(rowCount, 50));
  const firstRow = preview.locator("tbody tr").first();
  const firstCells = firstRow.getByRole("cell");
  await expect(firstCells.nth(0)).toHaveText("1");
  expect(expectedPreview.json.rows[0]).toMatchObject({ row_no: 1, document: { document_name: USABLE[0] } });
  expect(expectedPreview.json.rows[0].record_key).toBeTruthy();
  const apiFirst = expectedPreview.json.rows[0].cells;
  for (let i = 0; i < EXPECTED_HEADERS.length; i++) {
    const cell = apiFirst[i];
    expect(cell?.text, `API 미리보기 첫 행 ${EXPECTED_HEADERS[i]}`).toBeTruthy();
    await expect(firstCells.nth(i + 1).locator(".v3-build-cell > span").first()).toHaveText(cell!.text);
    await expect(firstCells.nth(i + 1).getByRole("button", { name: `${EXPECTED_HEADERS[i]} 1행 원본 보기` })).toHaveAttribute("title", `${cell!.sheet_name}!${cell!.range}`);
  }
  const tempIndex = EXPECTED_HEADERS.indexOf("온도_C");
  const tempCell = apiFirst[tempIndex]!;
  expect(tempCell).toMatchObject({ text: "150", rule_key: "temperature", sheet_name: "공정 기록", range: "C9" });
  expect(tempCell.application_id).toMatch(UUID);
  await expect(page.getByRole("region", { name: "제외 문서" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "충돌" })).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toMatch(UUID);

  // 온도_C 1행 원본 보기 → ?review=<application_id>&rule=temperature&sheet=<sheet_id>&range=C9 → Source Review overlay(뒤 화면 inert).
  await firstRow.getByRole("button", { name: "온도_C 1행 원본 보기" }).click();
  await expect(page).toHaveURL(new RegExp(`review=${tempCell.application_id}`));
  await expect(page).toHaveURL(/rule=temperature/);
  await expect(page).toHaveURL(new RegExp(`sheet=${tempCell.sheet_id}`));
  await expect(page).toHaveURL(/range=C9(&|$)/);
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  const context = review.locator(".v3-context").first();
  await expect(context.locator("strong")).toHaveText(USABLE[0]);
  await expect(context).toContainText("/ 공정 기록");
  await expect(context).toContainText(`/ ${PROFILE_V1}`);
  await expect(context).toContainText(`/ ${SCHEMA_NAME} v1`);
  await expect(context.locator(".v3-chip").first()).toHaveText("발행됨");
  const ruleButton = review.getByRole("group", { name: "파싱 규칙 목록" }).getByRole("button", { name: /^온도 / });
  await expect(ruleButton).toHaveAttribute("aria-current", "true");
  await expect(review.getByRole("group", { name: "시트 목록" }).getByRole("button", { name: /공정 기록/ })).toHaveAttribute("aria-current", "true");
  const reviewCell = (ref: string) => review.locator(`.v3-cell[data-ref="${ref}"]`);
  await expect(reviewCell("C9")).toHaveText("150", { timeout: 60_000 });
  await expect(reviewCell("C8")).toHaveText("온도");
  await expect(review.locator(".v3-overlay")).toHaveCount(2);
  await expect(review.locator('.v3-overlay.key[data-range="C8"] .v3-overlay-label')).toHaveText("키");
  await expect(review.locator('.v3-overlay.value[data-range="C9:C68"] .v3-overlay-label')).toHaveText("값");
  const valueBox = await review.locator('.v3-overlay.value[data-range="C9:C68"]').boundingBox();
  const c9Box = await reviewCell("C9").boundingBox();
  expect(valueBox && c9Box && Math.abs(valueBox.x - c9Box.x) < 6 && Math.abs(valueBox.y - c9Box.y) < 6, `overlay ${JSON.stringify(valueBox)} vs cell ${JSON.stringify(c9Box)}`).toBe(true);
  expect(await review.innerText()).not.toMatch(UUID);
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  await expect(page).toHaveURL(/screen=build/);
  await expect(page).toHaveURL(/step=4/);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(preview.locator("tbody tr")).toHaveCount(Math.min(rowCount, 50));

  // ---- 5단계: 생성. 기본 XLSX, CSV로 바꿔 생성 → 다운로드 내용 검사.
  await page.getByRole("button", { name: "다음: 생성" }).click();
  await expect(page).toHaveURL(/step=5/);
  await expectStep(page, "생성");
  await expect(page.getByRole("heading", { level: 2, name: "생성" })).toBeVisible();
  await expect(page.getByText(`문서 ${USABLE.length}개 · 컬럼 ${EXPECTED_HEADERS.length}개 · ${SCHEMA_NAME} v1`)).toBeVisible();
  const formats = page.getByRole("radiogroup", { name: "출력 형식" });
  await expect(formats.getByRole("radio")).toHaveCount(3);
  await expect(formats.getByRole("radio", { name: "XLSX" })).toBeChecked();
  await formats.getByRole("radio", { name: "CSV" }).check();
  const csvBuild = await generate(page, "파일 생성");
  expect(csvBuild.build_key).toMatch(/^[0-9a-f]{16}$/);
  expect(csvBuild.reused).toBe(false);
  expect(csvBuild.download_url).toBe(`/api/v3/builds/${csvBuild.build_key}/download?format=csv`);
  expect(csvBuild.manifest.row_count).toBe(rowCount);
  await expect(page.locator(".v3-toast").filter({ hasText: "데이터 빌드 완료 · CSV" })).toBeVisible();
  const result = page.getByRole("region", { name: "빌드 결과" });
  await expect(result.getByRole("heading", { level: 3 })).toContainText("data.csv");
  await expect(result.getByRole("heading", { level: 3 }).locator(".v3-chip")).toHaveText("완료");
  await expect(result).toContainText(`행 ${rowCount}개 · 컬럼 ${EXPECTED_HEADERS.length}개 · 원본 문서 ${USABLE.length}개`);
  const csvPath = await downloadResult(page, "data.csv");
  const csv = readCsv(csvPath);
  expect(csv[0]).toEqual([...EXPECTED_HEADERS, ...META_COLUMNS]);
  expect(csv[0].indexOf("온도_C")).toBeLessThan(csv[0].indexOf("측정일시"));
  expect(csv[0].indexOf("온도_C")).toBeLessThan(csv[0].indexOf("압력_bar"));
  expect(csv.length - 1).toBe(rowCount);
  expect(rowCount).toBeGreaterThanOrEqual(USABLE.length * LOT_COUNT);
  const dataRows = csv.slice(1);
  expect(dataRows[0].slice(0, EXPECTED_HEADERS.length)).toEqual(apiFirst.map((c) => c!.text));
  expect(new Set(dataRows.map((r) => r[csv[0].indexOf("_document")]))).toEqual(new Set(USABLE));
  expect(dataRows.every((r) => r[csv[0].indexOf("_record_key")] !== "")).toBe(true);
  expect(dataRows.every((r) => r[csv[0].indexOf("온도_C")] !== "" && r[csv[0].indexOf("압력_bar")] !== "")).toBe(true);
  expect(dataRows.every((r) => r.every((cell) => !UUID.test(cell)))).toBe(true);

  // 같은 입력으로 다시 생성하면 같은 build_key를 재사용한다.
  const csvAgain = await generate(page, "다시 생성");
  expect(csvAgain.build_key).toBe(csvBuild.build_key);
  expect(csvAgain.reused).toBe(true);

  // XLSX: 헤더(openpyxl) 검사. build_key는 형식과 무관하게 같다.
  await formats.getByRole("radio", { name: "XLSX" }).check();
  const xlsxBuild = await generate(page, "다시 생성");
  expect(xlsxBuild.build_key).toBe(csvBuild.build_key);
  await expect(page.locator(".v3-toast").filter({ hasText: "데이터 빌드 완료 · XLSX" })).toBeVisible();
  await expect(result.getByRole("heading", { level: 3 })).toContainText("data.xlsx");
  const xlsxPath = await downloadResult(page, "data.xlsx");
  expect(readXlsxHeaders(xlsxPath, "data")).toEqual([...EXPECTED_HEADERS, ...META_COLUMNS]);
  const xlsxRows = runPython(
    "import sys; from openpyxl import load_workbook; wb = load_workbook(sys.argv[1], read_only=True); print(sum(1 for _ in wb['data'].iter_rows(min_row=2)))",
    xlsxPath,
  ).trim();
  expect(Number(xlsxRows)).toBe(rowCount);

  // SQLite: data 표 행 수 + 컬럼(_source_<header>, _document, _record_key).
  await formats.getByRole("radio", { name: "SQLite" }).check();
  const sqliteBuild = await generate(page, "다시 생성");
  expect(sqliteBuild.build_key).toBe(csvBuild.build_key);
  await expect(result.getByRole("heading", { level: 3 })).toContainText("data.sqlite");
  const sqlitePath = await downloadResult(page, "data.sqlite");
  expect(sqliteRow(sqlitePath, "SELECT count(*) FROM data")).toEqual([rowCount]);
  const sqliteColumns = JSON.parse(
    runPython("import json, sqlite3, sys; c = sqlite3.connect(sys.argv[1]); print(json.dumps([r[1] for r in c.execute('PRAGMA table_info(data)')], ensure_ascii=False))", sqlitePath),
  ) as string[];
  expect(sqliteColumns).toEqual(["_row_no", ...EXPECTED_HEADERS, ...EXPECTED_HEADERS.map((h) => `_source_${h}`), ...META_COLUMNS]);
  expect(sqliteRow(sqlitePath, 'SELECT "온도_C", "_source_온도_C", "_document", "_record_key" FROM data ORDER BY _row_no LIMIT 1')).toEqual([150, "공정 기록!C9", USABLE[0], expect.any(String)]);
  expect(sqliteRow(sqlitePath, 'SELECT count(DISTINCT "_document") FROM data')).toEqual([USABLE.length]);

  // manifest 보기 → 원본 문서 3개 · 컬럼 11개 · 행 · 스키마 · 출력 컬럼 칩 · 원본 문서 표.
  await result.getByRole("button", { name: "manifest 보기" }).click();
  const summary = result.locator('[aria-label="manifest 요약"]');
  await expect(summary).toBeVisible();
  const kv = summary.locator("dl.v3-kv");
  await expect(kv.locator("dt")).toHaveText(["원본 문서", "컬럼", "행", "행 구성", "스키마", "제외", "충돌"]);
  await expect(kv.locator("dd")).toHaveText([`${USABLE.length}개`, `${EXPECTED_HEADERS.length}개`, `${rowCount}행`, "레코드마다 1행", `${SCHEMA_NAME} v1`, "0개", "0건"]);
  await expect(summary.locator('[aria-label="출력 컬럼"] .v3-chip')).toHaveText(EXPECTED_HEADERS.map((h) => (h === "온도_C" ? "온도_C (°C)" : h === "압력_bar" ? "압력_bar (bar)" : h === "시간" ? "시간 (min)" : h)));
  const sources = summary.getByRole("table", { name: "원본 문서" });
  await expect(sources.locator("tbody tr")).toHaveCount(USABLE.length);
  await expect(sources.locator("tbody tr td:nth-child(1)")).toHaveText(USABLE);
  await expect(sources.locator("tbody tr td:nth-child(2)")).toHaveText(USABLE.map(() => PROFILE_V1));
  const manifest = await api(page, "GET", `/builds/${csvBuild.build_key}/manifest`);
  expect(manifest.status).toBe(200);
  expect(manifest.json).toMatchObject({ build_key: csvBuild.build_key, row_count: rowCount, row_mode: "record", schema: { key: SCHEMA_KEY, rev: 1 } });
  expect(manifest.json.columns.map((c: { header: string }) => c.header)).toEqual(EXPECTED_HEADERS);
  expect(manifest.json.sources.map((s: { document_name: string }) => s.document_name)).toEqual(USABLE);
  expect(manifest.json.formats).toEqual({ csv: "data.csv", xlsx: "data.xlsx", sqlite: "data.sqlite" });
  expect(await page.locator("main").innerText()).not.toMatch(UUID);

  // 새 빌드 → 초안·출력 설정이 비워지고 1단계 빈 상태.
  await result.getByRole("button", { name: "새 빌드" }).click();
  await expect(page).not.toHaveURL(/step=/);
  await expectStep(page, "대상 문서");
  await expect(page.getByText("대상 문서가 없습니다. 문서 화면에서 문서를 선택해 데이터 빌드에 추가하세요.")).toBeVisible();
  await expect(page.getByRole("button", { name: "문서 화면에서 선택" })).toBeVisible();
  await expect(stepper(page).getByRole("button", { name: "스키마" })).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem("v3.build.draft"))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem("v3.build.columns"))).toBeNull();
  errors.assertClean();
});
