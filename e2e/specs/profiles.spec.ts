// 파싱 프로파일 화면 E2E(계약 §8 profiles.spec): 목록 → 탭 없는 단일 상세(요약줄 · 정의 JSON 편집기 · 테스트 · 변경 이력)
// → `+ 새 프로파일` 하나로 합친 만들기 대화상자(빈 골격/붙여넣기·형식 자동 판별) → 정의를 고쳐 새 리비전 저장 → 테스트 팝오버
// → Source Review(테스트 모드) → 재파싱(fill). 세 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false):
// 1번은 시드 프로파일을 읽기만 하고, 2번이 초안 프로파일 '가져온 양식'을 만들며, 3번이 시드 프로파일을 v2로 올려 테스트·재파싱을 돌린다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, openScreen, resetWorkspace, waitForJobs } from "./helpers";

const PROFILE_NAME = "공정데이터_A양식";
const PROFILE_V1 = "공정데이터_A양식 v1";
const PROFILE_V2 = "공정데이터_A양식 v2";
const SCHEMA_NAME = "공정 데이터 표준";
const SCHEMA_KEY = "process_standard";
const REFERENCE = "공정데이터_2024_01.xlsx";
const IDENTICAL = ["공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"];
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const IMPORTED_NAME = "가져온 양식";
const NEW_DESCRIPTION = "E2E에서 고친 설명 — 정의 JSON 편집기로 저장한 새 리비전";
const RULE_NAMES = ["제품명", "레시피명", "공정명", "설비명", "배치", "측정일시", "온도", "압력", "시간", "결과값", "판정"];
const RULE_KEYS = ["product_name", "recipe_name", "process_name", "equipment", "lot", "measured_at", "temperature", "pressure", "duration", "result_value", "verdict"];
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA_RE = /[0-9a-f]{64}/i;

// 이전 세대 파싱 템플릿(v1-parsing-template) 모양(sheet_templates → mappings.source.key_search).
const V1_TEMPLATE = {
  sheet_templates: [
    {
      name: "공정 기록",
      match: { names: ["공정 기록"] },
      mappings: [{ key: "temperature", concept_id: "temperature", source: { key_search: ["온도"], offset: { row: 0, col: 1 } }, value_type: "number" }],
    },
  ],
};

type ProfileRow = { profile_id: string; profile_name: string; status: string; current_rev: number; document_count: number };

const listTable = (page: Page) => page.getByRole("table", { name: "파싱 프로파일 목록" });
const rowOf = (page: Page, name: string) => listTable(page).getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
const detailOf = (page: Page) => page.getByRole("region", { name: "프로파일 상세" });
// 요약줄(연결 스키마 · 대표 문서 · 적용 문서)의 값 칸.
const summaryOf = (page: Page, term: string) =>
  detailOf(page).locator("dl[aria-label='프로파일 요약'] dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
const editorOf = (page: Page) => detailOf(page).getByLabel("프로파일 JSON");
const editorStatus = (page: Page) => detailOf(page).locator("p.app-muted.app-small[role='status']");

async function seededProfile(page: Page): Promise<ProfileRow> {
  const { status, json } = await api<{ items: ProfileRow[] }>(page, "GET", "/profiles?q=" + encodeURIComponent(PROFILE_NAME));
  expect(status).toBe(200);
  const row = json.items.find((p) => p.profile_name === PROFILE_NAME);
  expect(row, "시드 프로파일이 있어야 한다").toBeTruthy();
  return row!;
}

async function gotoProfiles(page: Page) {
  await page.goto("/?screen=profiles");
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "파싱 프로파일" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { level: 1, name: "파싱 프로파일" })).toBeVisible();
}

async function assertNoIds(page: Page) {
  const body = await page.locator("main").innerText();
  expect(body).not.toMatch(UUID_RE);
  expect(body).not.toMatch(SHA_RE);
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("목록 · 상태 필터 · 탭 없는 단일 상세(요약줄 · 정의 JSON · 변경 이력) · 대표 문서 지정 · 내보내기", async ({ page }) => {
  const errors = collectErrors(page);
  const seeded = await seededProfile(page);
  await gotoProfiles(page);

  // 목록: 시드 프로파일 1건 — v1 · 연결 스키마 · 적용 문서 수 4 · 승인 칩. 만들기 버튼은 `+ 새 프로파일` 하나뿐이다.
  await expect(page.getByRole("button", { name: "외부 Profile Import" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "+ 새 프로파일" })).toHaveCount(1);
  const table = listTable(page);
  await expect(table.getByRole("columnheader")).toHaveText(["프로파일명", "버전", "연결 스키마", "적용 문서 수", "상태", "최근 수정"]);
  await expect(table.locator("tbody tr")).toHaveCount(1);
  const row = rowOf(page, PROFILE_NAME);
  await expect(row.getByRole("cell").nth(1)).toHaveText("v1");
  await expect(row.getByRole("cell").nth(2)).toHaveText(SCHEMA_NAME);
  await expect(row.getByRole("cell").nth(3)).toHaveText(String(seeded.document_count));
  expect(seeded.document_count).toBe(4);
  await expect(row.getByRole("cell").nth(4).locator(".app-chip")).toHaveText("승인");
  await expect(row.getByRole("cell").nth(4).locator(".app-chip")).toHaveClass(/\bok\b/);
  await expect(row.getByRole("cell").nth(5)).toHaveText(/전$|^\d{4}-\d{2}-\d{2}/);
  await assertNoIds(page);

  // 상태 필터: 전체·초안·승인·폐기. 초안은 아직 없다.
  const filters = page.getByRole("search", { name: "프로파일 필터" });
  const statusSelect = filters.getByLabel("상태");
  await expect(statusSelect.locator("option")).toHaveText(["전체", "초안", "승인", "폐기"]);
  await statusSelect.selectOption("draft");
  await expect(page).toHaveURL(/status=draft/);
  await expect(page.getByText("조건에 맞는 파싱 프로파일이 없습니다.")).toBeVisible();
  await expect(table).toHaveCount(0);
  await statusSelect.selectOption("approved");
  await expect(rowOf(page, PROFILE_NAME)).toHaveCount(1);
  await statusSelect.selectOption("");
  await expect(page).not.toHaveURL(/status=/);
  // 검색(250ms 디바운스).
  const search = filters.getByLabel("프로파일 검색");
  await search.fill("없는프로파일");
  await expect(page.getByText("조건에 맞는 파싱 프로파일이 없습니다.")).toBeVisible();
  await search.fill("");
  await expect(rowOf(page, PROFILE_NAME)).toHaveCount(1);

  // 상세 열기: URL ?profile=, 좁은 목록(aria-current) + 상세 카드 머리(이름 vN · 승인 칩 · 행동 버튼).
  await row.getByRole("button", { name: PROFILE_NAME, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`profile=${seeded.profile_id}`));
  const detail = detailOf(page);
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V1 })).toBeVisible();
  await expect(detail.locator(".app-card-head .app-chip").first()).toHaveText("승인");
  await expect(detail.getByRole("button", { name: "테스트", exact: true })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "재파싱(rematch)" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "재파싱(fill)" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "내보내기" })).toBeEnabled();
  const sideList = page.locator(".app-side-list[aria-label='파싱 프로파일 목록']");
  await expect(sideList.getByRole("button")).toHaveCount(1);
  await expect(sideList.getByRole("button").first()).toHaveAttribute("aria-current", "true");
  await expect(sideList.getByRole("button").first()).toContainText(`v1 · ${SCHEMA_NAME} · 문서 4`);
  // 탭은 하나도 없다 — 같은 정의를 여러 방식으로 그리던 탭 6개를 모두 없앴다.
  await expect(detail.getByRole("tablist")).toHaveCount(0);
  for (const gone of ["기본 정보", "규칙", "필드 매핑", "JSON"]) await expect(detail.getByRole("tab", { name: gone })).toHaveCount(0);
  await expect(detail.getByRole("table", { name: "필드 매핑" })).toHaveCount(0);
  await expect(detail.locator("[aria-label='파싱 규칙 목록']")).toHaveCount(0);
  await expect(detail.getByRole("table", { name: "적용 문서" })).toHaveCount(0);

  // 요약줄: 연결 스키마 · 대표 문서(01 r1 · 기준 v1 · 자동 승인 · Source Review 열기) · 적용 문서 4개.
  // 설명은 머리 바로 아래 한 줄(정의 JSON 편집기 안에도 같은 글자가 있어 첫 문단으로 좁힌다).
  await expect(detail.locator("p.app-muted.app-small").first()).toHaveText("공정 기록 A양식: 머리 정보 4개 + LOT 표(열마다 규칙 1개) + 공통 정보 시트의 단위");
  await expect(summaryOf(page, "연결 스키마")).toHaveText(SCHEMA_NAME);
  await expect(summaryOf(page, "대표 문서")).toContainText(`${REFERENCE} r1`);
  await expect(summaryOf(page, "대표 문서")).toContainText(/승인 \d{4}-\d{2}-\d{2}/);
  await expect(summaryOf(page, "대표 문서")).toContainText("기준 v1");
  await expect(summaryOf(page, "대표 문서").locator(".app-chip")).toHaveText("자동 승인");
  await expect(summaryOf(page, "적용 문서")).toHaveText("4개");
  await assertNoIds(page);

  // 정의 JSON 편집기: 현재 리비전이 채워져 있고, 400ms 뒤 검증(오류 없음)이 자동으로 붙는다(따로 누를 '검증' 버튼은 없다).
  await expect(detail.getByRole("heading", { level: 3, name: "정의 JSON" })).toBeVisible();
  await expect(detail.getByRole("button", { name: "검증" })).toHaveCount(0);
  const editor = editorOf(page);
  await expect(editor).toBeVisible();
  const original = await editor.inputValue();
  expect(original).toContain('"sheet_roles"');
  expect(original).toContain(`"profile_name": "${PROFILE_NAME}"`);
  expect(original).toContain(`"schema_key": "${SCHEMA_KEY}"`);
  const parsedOriginal = JSON.parse(original) as { rules: { rule_key: string }[]; sheet_roles: Record<string, unknown> };
  expect(parsedOriginal.rules.map((r) => r.rule_key)).toEqual(RULE_KEYS);
  expect(Object.keys(parsedOriginal.sheet_roles).sort()).toEqual(["common", "main"]);
  await expect(editorStatus(page)).toHaveText("현재 리비전 v1과 같습니다.");
  const verdict = detail.locator("[aria-label='검증 결과']");
  await expect(verdict.locator(".app-chip")).toHaveText(["parsing-profile-3.0", "오류 없음"]);
  await expect(verdict.getByRole("list", { name: "오류" })).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "저장(새 리비전)" })).toBeEnabled();
  await expect(detail.getByRole("button", { name: "되돌리기" })).toBeDisabled();
  // 깨뜨리면 저장이 막히고, 되돌리면 원래대로 돌아온다.
  await editor.fill(original + "}");
  await expect(detail.getByRole("alert")).toContainText("JSON 문법 오류");
  await expect(editor).toHaveAttribute("aria-invalid", "true");
  await expect(detail.getByRole("button", { name: "저장(새 리비전)" })).toBeDisabled();
  await editor.fill("[1, 2]");
  await expect(detail.getByRole("alert")).toHaveText("정의는 JSON 객체여야 합니다.");
  await editor.fill(original.replace(`"${PROFILE_NAME}"`, `"${PROFILE_NAME} 수정중"`));
  await expect(editorStatus(page)).toContainText("저장되지 않은 변경이 있습니다.");
  await expect(detail.getByRole("button", { name: "되돌리기" })).toBeEnabled();
  await detail.getByRole("button", { name: "되돌리기" }).click();
  await expect(editor).toHaveValue(original);
  await expect(editorStatus(page)).toHaveText("현재 리비전 v1과 같습니다.");
  await expect(detail.getByRole("alert")).toHaveCount(0);

  // 내보내기: GET /profiles/{id}/export 다운로드, 내용은 canonical(규칙 11개).
  const downloadPromise = page.waitForEvent("download");
  const exportResponse = page.waitForResponse((r) => r.url().endsWith(`/api/profiles/${seeded.profile_id}/export`));
  await detail.getByRole("button", { name: "내보내기" }).click();
  // 내려받기는 먼저 상태를 확인하고(실패면 화면에 오류가 뜬다) 받은 본문을 파일로 저장한다 —
  // 그래서 링크 URL은 blob:이고 Chromium은 파일 이름을 'download'로 보고한다(이름은 단언하지 않는다).
  expect((await exportResponse).status()).toBe(200);
  const download = await downloadPromise;
  expect(download.url().startsWith("blob:")).toBe(true);
  const exported = JSON.parse(await streamToString(await download.createReadStream())) as { profile_name: string; rules: { rule_key: string }[]; format: string };
  expect(exported.profile_name).toBe(PROFILE_NAME);
  expect(exported.format).toBe("parsing-profile");
  expect(exported.rules.map((r) => r.rule_key)).toEqual(RULE_KEYS);

  // 변경 이력: r1(현재) 한 행.
  await expect(detail.getByRole("heading", { level: 3, name: "변경 이력" })).toBeVisible();
  const history = detail.getByRole("table", { name: "변경 이력" });
  // 계약 §7: 정의 파일에서 알 수 있는 값만 보여 준다(작성자·요약 열은 없앴다 — 언제나 "-"만 그렸다).
  await expect(history.getByRole("columnheader")).toHaveText(["리비전", "시각", "규칙", "행동"]);
  await expect(history.locator("tbody tr")).toHaveCount(1);
  const historyRow = history.locator("tbody tr").first();
  await expect(historyRow.getByRole("cell").nth(0)).toContainText("r1");
  await expect(historyRow.getByRole("cell").nth(0).locator(".app-chip")).toHaveText("현재");
  await expect(historyRow.getByRole("cell").nth(1)).toHaveText(/\d{4}-\d{2}-\d{2}/);
  await expect(historyRow.getByRole("cell").nth(2)).toHaveText(/^규칙 \d+개$/);

  // 대표 문서 지정 팝오버(§4.8 승인 진입점): 매핑을 모두 승인한 비대표 적용 건만 보인다 — 누르지 않는다(대표 문서가 바뀐다).
  await summaryOf(page, "대표 문서").getByRole("button", { name: "대표 문서 지정" }).click();
  const referencePopover = detail.getByRole("group", { name: "대표 문서 지정" });
  await expect(referencePopover).toBeVisible();
  const approvable = referencePopover.locator("[aria-label='승인 가능한 적용 건'] .app-list-item");
  await expect(approvable).toHaveCount(2);
  await expect(approvable.locator("strong")).toHaveText(IDENTICAL);
  await expect(approvable.first().locator("small")).toContainText("동일");
  await expect(approvable.first().locator("small")).toContainText("검수 11/11");
  await expect(approvable.first().getByRole("button", { name: "이 문서로 승인" })).toBeEnabled();
  await referencePopover.getByRole("button", { name: "닫기" }).click();
  await expect(referencePopover).toHaveCount(0);

  // 대표 문서의 Source Review 열기 → ?review=<대표 application_id> 오버레이(검수 모드), 돌아가면 상세 그대로.
  const profileDetail = await api(page, "GET", `/profiles/${seeded.profile_id}`);
  expect(profileDetail.json.reference.document_name).toBe(REFERENCE);
  await summaryOf(page, "대표 문서").getByRole("button", { name: "Source Review 열기" }).click();
  await expect(page).toHaveURL(new RegExp(`review=${profileDetail.json.reference.application_id}`));
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  await expect(review.locator("strong").first()).toHaveText(REFERENCE);
  await expect(review).toContainText(`/ ${PROFILE_V1}`);
  await expect(review).toContainText(`/ ${SCHEMA_NAME}`);
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  await expect(page).toHaveURL(new RegExp(`profile=${seeded.profile_id}`));
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V1 })).toBeVisible();

  // 다른 화면으로 갔다가 돌아와도 메뉴 aria-current가 따라온다.
  await openScreen(page, "문서");
  await openScreen(page, "파싱 프로파일");
  await expect(page).toHaveURL(/screen=profiles/);
  errors.assertClean();
});

test("+ 새 프로파일 하나로: 빈 골격 · v1 파싱 템플릿 붙여넣기(형식 판별 · 경고) → 저장 → 초안 프로파일", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoProfiles(page);
  await page.getByRole("button", { name: "+ 새 프로파일" }).click();
  const dialog = page.getByRole("dialog", { name: "새 프로파일" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("heading", { level: 2, name: "새 프로파일" })).toBeVisible();
  // 저장 전 초안에는 리비전이 없어 테스트할 수 없다 — 대화상자에는 테스트 버튼도 테스트 문서 목록도 없다.
  await expect(dialog).toContainText("저장한 뒤 상세 화면에서 문서를 골라 테스트하세요.");
  await expect(dialog.getByRole("button", { name: "대표 문서로 테스트" })).toHaveCount(0);
  await expect(dialog.getByLabel("테스트 문서")).toHaveCount(0);
  const schemaSelect = dialog.getByLabel("파싱 스키마");
  await expect(schemaSelect.locator("option")).toHaveText([SCHEMA_NAME]);
  await expect(schemaSelect).toHaveValue(SCHEMA_KEY);

  // 시작 방법 라디오 2개. 기본은 빈 골격 — canonical 3.0 골격이 채워져 있다.
  const startGroup = dialog.getByRole("radiogroup", { name: "시작 방법" });
  await expect(startGroup.getByRole("radio")).toHaveCount(2);
  await expect(startGroup.getByRole("radio", { name: "빈 골격으로 시작" })).toBeChecked();
  const definition = dialog.getByLabel("정의 JSON");
  const skeleton = JSON.parse(await definition.inputValue()) as { format: string; schema_version: string; schema_key: string; rules: { rule_key: string }[] };
  expect(skeleton).toMatchObject({ format: "parsing-profile", schema_version: "3.0", schema_key: SCHEMA_KEY });
  expect(skeleton.rules.map((r) => r.rule_key)).toEqual(["rule_1"]);

  // 붙여넣기로 바꾸면 편집기가 비고, 깨진 JSON은 저장이 막힌다.
  await startGroup.getByRole("radio", { name: "정의 붙여넣기 또는 파일 업로드" }).check();
  await expect(definition).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();
  await dialog.getByLabel("프로파일명").fill(IMPORTED_NAME);
  await definition.fill("{ nope");
  await expect(dialog.getByRole("alert")).toContainText("JSON 문법 오류");
  await expect(dialog.getByRole("button", { name: "저장" })).toBeDisabled();

  // v1 템플릿을 붙여넣으면 400ms 뒤 import-preview로 형식을 판별한다.
  const previewRequest = page.waitForRequest((r) => r.method() === "POST" && r.url().includes("/api/profiles/import-preview"));
  await definition.fill(JSON.stringify(V1_TEMPLATE, null, 2));
  const sent = (await previewRequest).postDataJSON() as { schema_key: string; format: string; definition: unknown };
  expect(sent.schema_key).toBe(SCHEMA_KEY);
  expect(sent.format).toBe("auto");
  expect(sent.definition).toEqual(V1_TEMPLATE);
  const preview = dialog.locator("[aria-label='변환 미리보기']");
  await expect(preview).toBeVisible();
  await expect(preview.locator("p.app-small .app-chip")).toHaveText(["v1-parsing-template", "오류 없음", "경고 2"]);
  await expect(preview.getByRole("list", { name: "오류" })).toHaveCount(0);
  const warnings = preview.getByRole("list", { name: "경고" }).getByRole("listitem");
  await expect(warnings).toHaveCount(2);
  await expect(warnings.nth(0)).toContainText("KEY_SEARCH_WINDOW");
  await expect(warnings.nth(0)).toContainText("sheet_templates[공정 기록].mappings[temperature].source.key_search");
  await expect(warnings.nth(0)).toContainText("v1은 시트 전체를 검색했지만 3.0은 A1:AZ100 안에서 검색합니다.");
  await expect(warnings.nth(1)).toContainText("CASEFOLD_MATCH");
  const canonicalText = await dialog.getByLabel("canonical 미리보기").inputValue();
  const canonical = JSON.parse(canonicalText) as {
    format: string;
    schema_version: string;
    schema_key: string;
    sheet_roles: Record<string, { cardinality: string; match: { name: string } }>;
    rules: { rule_key: string; field_key: string; selector: { key: { areas: { sheet_role: string; find: { texts: string[]; within: string } }[] }; value: { areas: { relative: { row: number; col: number } }[]; cardinality: string } }; value_spec: { type: string } }[];
  };
  expect(canonical.format).toBe("parsing-profile");
  expect(canonical.schema_version).toBe("3.0");
  expect(canonical.schema_key).toBe(SCHEMA_KEY);
  expect(canonical.sheet_roles["공정 기록"]).toEqual({ cardinality: "one", match: { name: "공정 기록" } });
  expect(canonical.rules).toHaveLength(1);
  expect(canonical.rules[0].rule_key).toBe("temperature");
  expect(canonical.rules[0].field_key).toBe("temperature");
  expect(canonical.rules[0].selector.key.areas[0].find).toMatchObject({ texts: ["온도"], within: "A1:AZ100" });
  expect(canonical.rules[0].selector.value.areas[0].relative).toMatchObject({ row: 0, col: 1 });
  expect(canonical.rules[0].selector.value.cardinality).toBe("scalar");
  expect(canonical.rules[0].value_spec.type).toBe("decimal");
  const dialogText = await dialog.innerText();
  expect(dialogText).not.toMatch(UUID_RE);

  // 저장 → POST /profiles {name, schema_key, definition, format:'auto'} → 대화상자 닫힘 · 토스트 · 새 프로파일 상세(초안).
  const saveRequest = page.waitForRequest((r) => r.method() === "POST" && /\/api\/profiles$/.test(r.url()));
  await dialog.getByRole("button", { name: "저장" }).click();
  const saved = (await saveRequest).postDataJSON() as { name: string; schema_key: string; format: string };
  expect(saved).toMatchObject({ name: IMPORTED_NAME, schema_key: SCHEMA_KEY, format: "auto" });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: `${IMPORTED_NAME} v1 저장됨` })).toBeVisible();
  await expect(page).toHaveURL(/profile=[0-9a-f-]{36}/);
  const importedId = new URL(page.url()).searchParams.get("profile")!;
  const detail = detailOf(page);
  await expect(detail.getByRole("heading", { level: 2, name: `${IMPORTED_NAME} v1` })).toBeVisible();
  await expect(detail.locator(".app-card-head .app-chip").first()).toHaveText("초안");
  await expect(detail.locator(".app-card-head .app-chip").first()).toHaveClass(/\bwarn\b/);
  // 초안은 재파싱할 수 없고, 대표 문서가 없으며 적용 문서도 없다.
  await expect(detail.getByRole("button", { name: "재파싱(rematch)" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "재파싱(fill)" })).toBeDisabled();
  await expect(detail.getByRole("button", { name: "재파싱(fill)" })).toHaveAttribute("title", "승인된 프로파일만 재파싱할 수 있습니다.");
  await expect(summaryOf(page, "대표 문서")).toContainText("없음");
  await expect(summaryOf(page, "적용 문서")).toHaveText("0개");
  // 정의 JSON 편집기에는 변환된 규칙 1개(temperature)가 들어 있다.
  const imported = JSON.parse(await editorOf(page).inputValue()) as { profile_name: string; rules: { rule_key: string; field_key: string }[] };
  expect(imported.profile_name).toBe(IMPORTED_NAME);
  expect(imported.rules.map((r) => r.rule_key)).toEqual(["temperature"]);
  expect(imported.rules[0].field_key).toBe("temperature");
  // 좁은 목록에는 두 프로파일, 새 프로파일이 현재 항목이며 초안 칩을 단다.
  const sideList = page.locator(".app-side-list[aria-label='파싱 프로파일 목록']");
  await expect(sideList.getByRole("button")).toHaveCount(2);
  const sideItem = sideList.getByRole("button").filter({ hasText: IMPORTED_NAME });
  await expect(sideItem).toHaveAttribute("aria-current", "true");
  await expect(sideItem.locator(".app-chip")).toHaveText("초안");
  await expect(sideItem).toContainText(`v1 · ${SCHEMA_NAME} · 문서 0`);

  // 목록으로 돌아오면 2행: 새 프로파일은 v1 · 적용 문서 0 · 초안(.warn). 상태 필터 초안 → 그 행만.
  await gotoProfiles(page);
  const table = listTable(page);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const importedRow = rowOf(page, IMPORTED_NAME);
  await expect(importedRow.getByRole("cell").nth(1)).toHaveText("v1");
  await expect(importedRow.getByRole("cell").nth(2)).toHaveText(SCHEMA_NAME);
  await expect(importedRow.getByRole("cell").nth(3)).toHaveText("0");
  await expect(importedRow.getByRole("cell").nth(4).locator(".app-chip")).toHaveText("초안");
  await expect(importedRow.getByRole("cell").nth(4).locator(".app-chip")).toHaveClass(/\bwarn\b/);
  await expect(rowOf(page, PROFILE_NAME).getByRole("cell").nth(4).locator(".app-chip")).toHaveText("승인");
  await page.getByRole("search", { name: "프로파일 필터" }).getByLabel("상태").selectOption("draft");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(rowOf(page, IMPORTED_NAME)).toHaveCount(1);
  await assertNoIds(page);
  // API: 초안 · v1-parsing-template에서 온 규칙 1개(온도 필드).
  const created = await api(page, "GET", `/profiles/${importedId}`);
  expect(created.status).toBe(200);
  expect(created.json).toMatchObject({ profile_name: IMPORTED_NAME, status: "draft", current_rev: 1, document_count: 0, reference: null, auto_approval_active: false });
  expect(created.json.rules.map((r: { rule_key: string }) => r.rule_key)).toEqual(["temperature"]);
  expect(created.json.rules[0].field).toMatchObject({ key: "temperature", name: "온도", type: "decimal", unit: "°C" });
  errors.assertClean();
});

test("정의 JSON 편집 → 새 리비전 저장 → 테스트 팝오버 → Source Review(테스트 모드) · 재파싱(fill)", async ({ page }) => {
  const errors = collectErrors(page);
  const seeded = await seededProfile(page);
  const documents = await api(page, "GET", `/profiles/${seeded.profile_id}/documents`);
  const second = documents.json.items.find((d: { document_name: string }) => d.document_name === IDENTICAL[0]);
  expect(second).toBeTruthy();
  const snapshotId = second.snapshot.snapshot_id as string;
  const sheets = await api(page, "GET", `/snapshots/${snapshotId}/sheets`);
  const mainSheet = sheets.json.items.find((s: { sheet_name: string }) => s.sheet_name === "공정 기록");
  const commonSheet = sheets.json.items.find((s: { sheet_name: string }) => s.sheet_name === "공통 정보");

  await page.goto(`/?screen=profiles&profile=${seeded.profile_id}`);
  const detail = detailOf(page);
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V1 })).toBeVisible();

  // ---- 정의 JSON을 고쳐 저장하면 새 리비전(v2)이 된다.
  const editor = editorOf(page);
  const original = await editor.inputValue();
  const edited = { ...(JSON.parse(original) as Record<string, unknown>), description: NEW_DESCRIPTION };
  await editor.fill(JSON.stringify(edited, null, 2));
  await expect(editorStatus(page)).toContainText("저장되지 않은 변경이 있습니다.");
  await expect(detail.locator("[aria-label='검증 결과'] .app-chip")).toHaveText(["parsing-profile-3.0", "오류 없음"]);
  const saveRequest = page.waitForRequest((r) => r.method() === "PUT" && r.url().includes(`/api/profiles/${seeded.profile_id}`));
  await detail.getByRole("button", { name: "저장(새 리비전)" }).click();
  expect(((await saveRequest).postDataJSON() as { definition: { description: string } }).definition.description).toBe(NEW_DESCRIPTION);
  await expect(page.getByRole("status").filter({ hasText: `${PROFILE_V2} 저장됨` })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V2 })).toBeVisible();
  await expect(detail.locator("p.app-muted.app-small").first()).toHaveText(NEW_DESCRIPTION);
  await expect(editorStatus(page)).toHaveText("현재 리비전 v2과 같습니다.");
  // 승인 상태와 대표 문서는 그대로(기준은 승인 당시 v1).
  await expect(detail.locator(".app-card-head .app-chip").first()).toHaveText("승인");
  await expect(summaryOf(page, "대표 문서")).toContainText("기준 v1");
  // 변경 이력이 두 줄이 되고, r1을 열면 읽기 전용으로 보인다.
  const history = detail.getByRole("table", { name: "변경 이력" });
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(history.locator("tbody tr").nth(0).getByRole("cell").nth(0)).toContainText("r2");
  await expect(history.locator("tbody tr").nth(0).locator(".app-chip")).toHaveText("현재");
  await history.locator("tbody tr").nth(1).getByRole("button", { name: "이 리비전 보기" }).click();
  await expect(page).toHaveURL(/rev=1/);
  await expect(detail.getByRole("status").filter({ hasText: "리비전 v1을(를) 읽기 전용으로 보고 있습니다." })).toBeVisible();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(editor).toHaveValue(original);
  await expect(detail.getByRole("button", { name: "저장(새 리비전)" })).toBeDisabled();
  await detail.getByRole("button", { name: `현재 리비전(v2)으로 돌아가기` }).click();
  await expect(page).not.toHaveURL(/rev=/);
  await expect(editor).not.toHaveAttribute("readonly", "");
  const savedApi = await api(page, "GET", `/profiles/${seeded.profile_id}`);
  expect(savedApi.json).toMatchObject({ current_rev: 2, status: "approved", description: NEW_DESCRIPTION });
  await assertNoIds(page);

  // ---- 테스트 팝오버: 적용 문서 4건 + 문서 검색. 저장된 현재 리비전(v2)을 고른 문서에 적용해 본다.
  await detail.getByRole("button", { name: "테스트", exact: true }).click();
  const testPopover = detail.getByRole("group", { name: "테스트 문서 고르기" });
  await expect(testPopover).toBeVisible();
  await expect(testPopover).toContainText("문서를 고르면 저장된 현재 리비전을 적용한 결과를 Source Review에서 확인합니다(저장하지 않습니다).");
  const run = testPopover.getByRole("button", { name: "테스트 실행" });
  await expect(run).toBeDisabled();
  const applied = testPopover.getByRole("radiogroup", { name: "적용 문서" });
  await expect(applied.getByRole("radio")).toHaveCount(4);
  await expect(applied.locator("strong")).toHaveText([REFERENCE, ...IDENTICAL, SHIFTED]);
  await expect(applied.locator("small").first()).toHaveText("이 프로파일이 적용된 문서");
  // 문서 검색: 적용되지 않은 문서(품질검사)만 검색 결과에 나온다.
  await testPopover.getByLabel("문서 검색").fill("품질");
  const found = testPopover.getByRole("radiogroup", { name: "검색 결과" });
  await expect(found.getByRole("radio", { name: "품질검사_2024_05.xlsx" })).toBeVisible();
  await expect(found.locator("small").first()).toHaveText("검색된 문서");
  await testPopover.getByLabel("문서 검색").fill("");
  await expect(found).toHaveCount(0);
  await applied.getByRole("radio", { name: IDENTICAL[0] }).check();
  await expect(run).toBeEnabled();

  // 테스트 실행 → ?test=<profile_id>&snapshot=<sid> → POST /profiles/{id}/test {snapshot_id} → 오버레이(테스트 모드).
  const testRequest = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/profiles/${seeded.profile_id}/test`));
  await run.click();
  expect((await testRequest).postDataJSON()).toEqual({ snapshot_id: snapshotId });
  await expect(page).toHaveURL(new RegExp(`test=${seeded.profile_id}`));
  await expect(page).toHaveURL(new RegExp(`snapshot=${snapshotId}`));
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  const context = review.locator(".app-context").first();
  await expect(context.locator("strong").first()).toHaveText(PROFILE_V2);
  await expect(context.locator(".app-chip").first()).toHaveText("테스트");
  await expect(context).toContainText(`/ ${SCHEMA_NAME}`);
  await expect(context).toContainText("/ 공정 기록");
  await expect(context).toContainText("저장하지 않는 실행입니다");
  await expect(context.getByRole("button", { name: "다시 실행" })).toBeVisible();
  await expect(context.getByRole("button", { name: "닫기" })).toBeVisible();
  // 승인 관련 행동은 없다.
  for (const name of ["승인", "반려", "수정", "모두 승인", "이 문서로 승인"]) await expect(review.getByRole("button", { name, exact: true })).toHaveCount(0);

  // 좌: 시트 목록(역할 main/common) + 규칙 11개(값 개수 칩). 기본 선택 규칙은 첫 규칙(제품명).
  const sheetList = review.getByRole("group", { name: "시트 목록" });
  await expect(sheetList.getByRole("button")).toHaveCount(2);
  await expect(sheetList.getByRole("button").nth(0)).toContainText("공정 기록");
  await expect(sheetList.getByRole("button").nth(0)).toContainText("역할: main");
  await expect(sheetList.getByRole("button").nth(0)).toHaveAttribute("aria-current", "true");
  await expect(sheetList.getByRole("button").nth(1)).toContainText("공통 정보");
  await expect(sheetList.getByRole("button").nth(1)).toContainText("역할: common");
  const rules = review.getByRole("group", { name: "파싱 규칙 목록" });
  await expect(rules.getByRole("button")).toHaveCount(11);
  await expect(rules.getByRole("button").locator("strong")).toHaveText(RULE_NAMES);
  await expect(rules.getByRole("button").locator("small")).toHaveText(RULE_KEYS);
  await expect(rules.getByRole("button").locator(".app-chip")).toHaveText(["값 1", "값 1", "값 1", "값 1", "값 12", "값 12", "값 12", "값 12", "값 12", "값 12", "값 12"]);
  await expect(rules.getByRole("button").nth(0)).toHaveAttribute("aria-current", "true");

  // 우: 테스트 결과(동일 · 규칙 11개) — 제품명: 관찰된 키 제품명, 값 1개(제품-02 @ 공정 기록!B3), 원본 위치 키 A3 · 값 B3.
  const panel = review.getByTestId("test-panel");
  await expect(panel.getByRole("heading", { level: 3, name: "테스트 결과" })).toBeVisible();
  // 새 리비전(v2)은 대표 문서 승인 당시 리비전(v1)과 다르므로 판정은 '동일'이 아니라 '호환'이다(§3.3).
  await expect(panel.locator(".app-chip").first()).toHaveText("호환");
  await expect(panel).toContainText("규칙 11개");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const panelValue = (term: string) => panel.locator("dl.app-kv dt", { hasText: term }).locator("xpath=following-sibling::dd[1]");
  await expect(panelValue("파싱 규칙")).toHaveText("product_name");
  await expect(panelValue("필드").locator("strong")).toHaveText("제품명");
  await expect(panelValue("관찰된 키")).toHaveText("제품명");
  await expect(panelValue("값 개수")).toHaveText("1");
  await expect(panelValue("원본 위치").getByRole("button")).toHaveText(["키: 공정 기록!A3", "값: 공정 기록!B3"]);
  const values = panel.getByRole("table", { name: "테스트 값" });
  await expect(values.getByRole("columnheader")).toHaveText(["#", "값", "단위", "원본 위치"]);
  await expect(values.locator("tbody tr")).toHaveCount(1);
  await expect(values.locator("tbody tr").first().getByRole("cell")).toHaveText(["1", "제품-02", "-", "공정 기록!B3"]);
  // 중앙 뷰어: 실제 셀과 key/value overlay(제품명 A3 · 값 B3).
  const cell = (ref: string) => review.locator(`.app-cell[data-ref="${ref}"]`);
  await expect(cell("A3")).toHaveText("제품명", { timeout: 60_000 });
  await expect(cell("B3")).toHaveText("제품-02");
  await expect(review.locator(".app-overlay[data-kind='key']")).toHaveCount(1);
  await expect(review.locator(".app-overlay[data-kind='value']")).toHaveCount(1);
  await expect(review.locator(".app-overlay[data-kind='key'] .app-overlay-label")).toHaveText("키");
  await expect(review.locator(".app-overlay[data-kind='value'] .app-overlay-label")).toHaveText("값");

  // 규칙 온도 → ?rule=temperature: 관찰된 키 온도, 값 12개(150 °C @ C9 …), 단위 위치는 공통 정보!B1, 뷰어에 unit overlay는 다른 시트라 없다.
  await rules.getByRole("button", { name: /^온도/ }).click();
  await expect(page).toHaveURL(/rule=temperature/);
  await expect(rules.getByRole("button", { name: /^온도/ })).toHaveAttribute("aria-current", "true");
  await expect(panelValue("파싱 규칙")).toHaveText("temperature");
  await expect(panelValue("필드")).toContainText("온도");
  await expect(panelValue("필드")).toContainText("decimal · °C");
  await expect(panelValue("관찰된 키")).toHaveText("온도");
  await expect(panelValue("값 개수")).toHaveText("12");
  await expect(panelValue("원본 위치").getByRole("button")).toHaveText(["키: 공정 기록!C8", "값: 공정 기록!C9:C68", "단위: 공통 정보!B1"]);
  await expect(values.locator("tbody tr")).toHaveCount(12);
  await expect(values.locator("tbody tr").nth(0).getByRole("cell")).toHaveText(["1", "150", "°C", "공정 기록!C9"]);
  await expect(values.locator("tbody tr").nth(1).getByRole("cell")).toHaveText(["2", "152.5", "°C", "공정 기록!C10"]);
  await expect(values.locator("tbody tr").nth(11).getByRole("cell").nth(3)).toHaveText("공정 기록!C20");
  await expect(cell("C8")).toHaveText("온도");
  await expect(cell("C9")).toHaveText("150");
  await expect(review.locator(".app-overlay[data-kind='key']")).toHaveCount(1);
  await expect(review.locator(".app-overlay[data-kind='value']")).toHaveCount(1);
  await expect(review.locator(".app-overlay[data-kind='unit']")).toHaveCount(0);
  // 단위 위치를 누르면 공통 정보 시트로 옮겨 가 B1(°C)을 보여 준다.
  await panelValue("원본 위치").getByRole("button", { name: "단위: 공통 정보!B1" }).click();
  await expect(page).toHaveURL(new RegExp(`sheet=${commonSheet.sheet_id}`));
  await expect(page).toHaveURL(/range=B1/);
  await expect(sheetList.getByRole("button").nth(1)).toHaveAttribute("aria-current", "true");
  await expect(cell("B1")).toHaveText("°C", { timeout: 60_000 });
  await expect(cell("A1")).toHaveText("온도 단위");
  await expect(review.locator(".app-overlay[data-kind='unit']")).toHaveCount(1);
  await expect(review.locator(".app-overlay[data-kind='value']")).toHaveCount(0);
  await expect(review.getByText("렌더링 중")).toHaveCount(0);
  const reviewText = await review.innerText();
  expect(reviewText).not.toMatch(UUID_RE);
  expect(reviewText).not.toMatch(SHA_RE);
  // 값 행의 원본 위치를 누르면 공정 기록 시트 C10으로 돌아간다.
  await values.locator("tbody tr").nth(1).getByRole("button", { name: "공정 기록!C10" }).click();
  await expect(page).toHaveURL(new RegExp(`sheet=${mainSheet.sheet_id}`));
  await expect(page).toHaveURL(/range=C10/);
  await expect(cell("C10")).toHaveText("152.5", { timeout: 60_000 });
  // 다시 실행은 같은 요청을 한 번 더 보낸다.
  const rerun = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/profiles/${seeded.profile_id}/test`));
  await context.getByRole("button", { name: "다시 실행" }).click();
  expect((await rerun).postDataJSON()).toEqual({ snapshot_id: snapshotId });
  await expect(panelValue("값 개수")).toHaveText("12");
  // 테스트는 application 행을 만들지 않고 kind='test' 작업만 남긴다(§4.7).
  const jobs = await api(page, "GET", "/jobs?kind=test");
  expect(jobs.json.items.length).toBeGreaterThanOrEqual(2);
  for (const job of jobs.json.items) {
    expect(job).toMatchObject({ kind: "test", state: "succeeded", target_kind: "profile", target_id: seeded.profile_id, result: { errors: 0, groups: 11, compatibility: "compatible" } });
    expect(job.label).toContain(IDENTICAL[0]);
  }
  const after = await api(page, "GET", `/profiles/${seeded.profile_id}/documents`);
  expect(after.json.items).toHaveLength(4);

  // 닫기 → 오버레이 사라지고 test·snapshot·rule·range가 URL에서 지워지며 상세는 그대로.
  await context.getByRole("button", { name: "닫기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/test=/);
  await expect(page).not.toHaveURL(/snapshot=/);
  await expect(page).not.toHaveURL(/rule=/);
  await expect(page).not.toHaveURL(/range=/);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V2 })).toBeVisible();

  // 재파싱(fill): 승인됐지만 추출되지 않은 문서를 채운다 — 시드에서는 4건 모두 건너뜀(발행됨 3 · 검수 필요 1).
  const reparseRequest = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/profiles/${seeded.profile_id}/reparse`));
  await detail.getByRole("button", { name: "재파싱(fill)" }).click();
  const reparse = await reparseRequest;
  expect(new URL(reparse.url()).searchParams.get("wait")).toBe("10");
  expect(reparse.postDataJSON()).toEqual({ mode: "fill" });
  await expect(page.getByRole("status").filter({ hasText: "재파싱(fill) 완료 · 0건 처리 · 4건 건너뜀" })).toBeVisible();
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "재파싱(fill)" })).toBeEnabled();
  await waitForJobs(page);
  const reparseJobs = await api(page, "GET", "/jobs?kind=reparse");
  const fill = reparseJobs.json.items.find((j: { label: string }) => j.label === `${PROFILE_V2} · 재파싱(fill)`);
  expect(fill).toBeTruthy();
  expect(fill).toMatchObject({ state: "succeeded", target_kind: "profile", target_id: seeded.profile_id, completed: 4, total: 4 });
  expect(fill.result.queued).toBe(0);
  expect(fill.result.skipped.map((s: { document_name: string; reason: string }) => [s.document_name, s.reason])).toEqual([
    [REFERENCE, "published"],
    [IDENTICAL[0], "published"],
    [IDENTICAL[1], "published"],
    [SHIFTED, "review_required"],
  ]);
  // 작업 내역 화면에도 같은 작업이 재파싱 종류로 보인다.
  await openScreen(page, "작업 내역");
  await expect(page.getByText(`${PROFILE_V2} · 재파싱(fill)`).first()).toBeVisible();
  await assertNoIds(page);
  errors.assertClean();
});

async function streamToString(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
