// 파싱 스키마 화면 E2E(계약 §8 schema.spec): 목록 → 상세 헤더 → 구조 보기(트리/그래프 토글) → 필드 상세 → 사용 프로파일·연관 문서 탭 추적
// → 필드에서 Source Review → 필드 편집(alias PATCH) → 변경 이력 → 생성·삭제(§4.2.1·§4.2.2) → 폐기·폐기 해제(§4.2.3).
// 네 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false): 1번은 읽기만 하고, 2번이 PATCH로 새 리비전(r2)을 만들며,
// 3번이 임시 스키마를 만들었다 지우고 사용 중인 필드·스키마 삭제가 409로 막히는지 본다. 4번은 시드 스키마를 폐기했다가
// 되돌린다(정의는 지우지 않는다 — 폐기는 되돌릴 수 있는 일이다). 모든 단언은 실제 표시 문구를 본다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, openScreen, resetWorkspace } from "./helpers";

const SCHEMA_KEY = "process_standard";
const SCHEMA_NAME = "공정 데이터 표준";
const PROFILE_NAME = "공정데이터_A양식";
const PROFILE_V1 = `${PROFILE_NAME} v1`;
const GROUPS = ["기본 정보", "공정 정보", "결과 정보"];
const FIELDS = ["제품명", "레시피명", "공정명", "설비명", "배치", "측정일시", "온도", "압력", "시간", "결과값", "판정"];
const PUBLISHED_DOCUMENTS = ["공정데이터_2024_01.xlsx", "공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"];
const SHIFTED = "공정데이터_2024_04_양식이동.xlsx";
const LATEST_DOCUMENT = "공정데이터_2024_03.xlsx"; // 마지막으로 발행된 실행 → 필드 '최근 값'은 모두 이 문서에서 온다.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SHA256 = /[0-9a-f]{64}/i;

// 3번 test가 만들고 지우는 임시 스키마. 이름은 시드 스키마(공정 데이터 표준) 뒤에 오게 두어 목록 기본 선택이 흔들리지 않게 한다.
const NEW_SCHEMA_KEY = "e2e_temp";
const NEW_SCHEMA_NAME = "임시 검증 스키마";
const NEW_SCHEMA = {
  format: "parsing-schema",
  schema_version: "3.0",
  schema_key: NEW_SCHEMA_KEY,
  schema_name: NEW_SCHEMA_NAME,
  description: "E2E가 만들고 지우는 임시 스키마",
  fields: [
    { field_key: "sample_group", name: "표본 그룹", type: "group", level: 1 },
    { field_key: "sample_value", name: "표본 값", type: "decimal", unit: "mm", level: 2, parents: ["sample_group"] },
  ],
};
const TEMP_FIELD_KEY = "sample_extra";
const TEMP_FIELD_NAME = "임시 필드";
const SCHEMA_EXISTS_MESSAGE = "이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요.";

const schemaList = (page: Page) => page.getByRole("region", { name: "스키마 목록" });
const schemaDetail = (page: Page) => page.getByRole("region", { name: "스키마 상세" });
const fieldDetail = (page: Page) => page.getByRole("region", { name: "필드 상세" });
const tabs = (page: Page) => page.getByRole("tablist", { name: "스키마 상세 탭" });
const viewToggle = (page: Page) => page.getByRole("group", { name: "구조 보기 방식" });
const tree = (page: Page) => page.getByRole("tree", { name: "필드 트리" });
// 트리 항목은 field_key로 찾는다(그룹 항목은 자식 이름도 품고 있어 이름 필터로는 겹친다).
const FIELD_KEYS: Record<string, string> = { "기본 정보": "basic", "공정 정보": "process", "결과 정보": "result", 온도: "temperature", 압력: "pressure" };
const treeItem = (page: Page, name: string) => tree(page).locator(`[role="treeitem"][data-field-key="${FIELD_KEYS[name]}"]`);
const kv = (page: Page, term: string) => fieldDetail(page).locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");

async function gotoSchema(page: Page, query = "") {
  await page.goto("/?screen=schema" + query);
  await expect(page.getByRole("navigation", { name: "주 메뉴" }).getByRole("button", { name: "파싱 스키마" })).toHaveAttribute("aria-current", "page");
  await expect(schemaDetail(page).getByRole("heading", { level: 2 })).toContainText(SCHEMA_NAME);
}

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("스키마 목록 · 상세 헤더 · 트리/그래프 토글 · 필드 상세 · 사용 프로파일/연관 문서 추적 · 필드에서 Source Review", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await openScreen(page, "파싱 스키마");
  await expect(page).toHaveURL(/screen=schema/);
  await expect(page.getByRole("heading", { level: 1, name: "파싱 스키마" })).toBeVisible();

  // 목록: 스키마 1건과 필드·프로파일·문서 수. 첫 항목이 자동 선택된다(aria-current).
  const list = schemaList(page);
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (1)");
  const item = list.getByRole("button", { name: new RegExp(SCHEMA_NAME) });
  await expect(item).toHaveCount(1);
  await expect(item.locator("strong")).toHaveText(SCHEMA_NAME);
  await expect(item.locator("small")).toHaveText("필드 14 · 프로파일 1 · 문서 4");
  await expect(item).toHaveAttribute("aria-current", "true");
  await expect(item).toHaveClass(/\bselected\b/);
  // 검색(250ms 디바운스): 없는 이름 → 빈 상태, 지우면 복귀.
  const search = list.getByLabel("스키마 검색");
  await search.fill("없는스키마");
  await expect(list.getByText("조건에 맞는 파싱 스키마가 없습니다.")).toBeVisible();
  await search.fill("공정");
  await expect(item).toBeVisible();
  await search.fill("");

  // 상세 헤더: '공정 데이터 표준 v1' + 활성 칩, 수 요약, 설명, 탭 4개(N 포함).
  const detail = schemaDetail(page);
  const heading = detail.getByRole("heading", { level: 2 });
  await expect(heading).toContainText(`${SCHEMA_NAME} v1`);
  await expect(heading.locator(".app-chip")).toHaveText("활성");
  await expect(heading.locator(".app-chip")).toHaveClass(/\bok\b/);
  await expect(detail.locator(".app-card-head .app-muted")).toHaveText("필드 14 · 프로파일 1 · 문서 4");
  await expect(detail.getByText("공정 기록 문서에서 추출하는 표준 필드")).toBeVisible();
  await expect(tabs(page).getByRole("tab")).toHaveText(["구조 보기", "사용 프로파일 (1)", "연관 문서 (4)", "변경 이력"]);
  await expect(tabs(page).getByRole("tab", { name: "구조 보기" })).toHaveAttribute("aria-selected", "true");

  // 구조 보기 기본 = 트리. 그룹 3개(펼침) + 필드 11개 = 14 treeitem, 루트에 스키마 이름과 '필드 14'.
  await expect(viewToggle(page).getByRole("button", { name: "트리 보기" })).toHaveAttribute("aria-pressed", "true");
  await expect(viewToggle(page).getByRole("button", { name: "그래프 보기" })).toHaveAttribute("aria-pressed", "false");
  await expect(page).not.toHaveURL(/view=/);
  await expect(detail.locator(".app-tree-root strong")).toHaveText(SCHEMA_NAME);
  await expect(detail.locator(".app-tree-root")).toContainText("필드 14");
  const allItems = tree(page).locator('[role="treeitem"]');
  await expect(allItems).toHaveCount(14);
  const groupItems = tree(page).locator('[role="treeitem"][aria-level="1"]');
  await expect(groupItems.locator(":scope > .app-tree-row .app-tree-name")).toHaveText(GROUPS);
  for (const group of GROUPS) await expect(treeItem(page, group)).toHaveAttribute("aria-expanded", "true");
  await expect(tree(page).locator('[role="treeitem"][aria-level="2"] .app-tree-name')).toHaveText(FIELDS);
  await expect(treeItem(page, "온도").locator(":scope > .app-tree-row small")).toHaveText("decimal · °C");
  await expect(treeItem(page, "온도")).toHaveAttribute("aria-level", "2");
  await expect(treeItem(page, "공정 정보").locator('[role="group"] [role="treeitem"] .app-tree-name')).toHaveText(["공정명", "설비명", "배치", "측정일시", "온도", "압력", "시간"]);
  // 접기/펼치기는 클라이언트 상태(추가 호출 없음).
  await tree(page).getByRole("button", { name: "접기 기본 정보" }).click();
  await expect(treeItem(page, "기본 정보")).toHaveAttribute("aria-expanded", "false");
  await expect(allItems).toHaveCount(12);
  await tree(page).getByRole("button", { name: "펼치기 기본 정보" }).click();
  await expect(allItems).toHaveCount(14);
  // 필드를 고르기 전 우측 열은 안내만.
  await expect(fieldDetail(page)).toContainText("트리나 그래프에서 필드를 선택하세요.");

  // 그래프 보기: ?view=graph, SVG 노드 14(그룹 3 + 필드 11), 간선 = parent_of 11 + related_to 1(온도 ~ 압력, 점선).
  await viewToggle(page).getByRole("button", { name: "그래프 보기" }).click();
  await expect(page).toHaveURL(/view=graph/);
  await expect(viewToggle(page).getByRole("button", { name: "그래프 보기" })).toHaveAttribute("aria-pressed", "true");
  await expect(tree(page)).toHaveCount(0);
  const svg = detail.getByRole("img", { name: "스키마 그래프" });
  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("data-nodes", "14");
  await expect(svg).toHaveAttribute("data-edges", "12");
  await expect(detail.getByLabel("범례")).toContainText("노드 14 · 관계 12");
  await expect(svg.locator(".app-graph-hull")).toHaveCount(3);
  for (const group of GROUPS) await expect(svg.locator(".app-graph-hull-label", { hasText: group })).toHaveCount(1);
  await expect(svg.locator(".app-graph-node.root")).toContainText(SCHEMA_NAME);
  const fieldNodes = svg.locator('.app-graph-node[data-level="2"]');
  await expect(fieldNodes).toHaveCount(11);
  await expect(svg.locator('.app-graph-node.group[data-level="1"]')).toHaveCount(3);
  const temperatureNode = svg.getByRole("button", { name: "온도", exact: true });
  await expect(temperatureNode).toHaveAttribute("data-field-key", "temperature");
  await expect(temperatureNode).toContainText("문서 3 · 프로파일 1");
  await expect(temperatureNode).toHaveAttribute("aria-pressed", "false");
  const related = svg.locator('line[data-relation="related_to"]');
  await expect(related).toHaveCount(1);
  await expect(related).toHaveAttribute("data-from", "temperature");
  await expect(related).toHaveAttribute("data-to", "pressure");
  await expect(related).toHaveAttribute("stroke-dasharray", "5 4");
  await expect(svg.locator('line[data-relation="parent_of"]')).toHaveCount(11 + 3); // 필드→그룹 11 + 루트→그룹 3
  await expect(svg.locator('line[data-relation="parent_of"][data-from="process"][data-to="temperature"]')).toHaveCount(1);
  await expect(svg.locator('line[data-relation="parent_of"][data-from="process"][data-to="temperature"]')).not.toHaveAttribute("stroke-dasharray", /./);
  // 그래프 확대 select.
  const zoom = detail.getByLabel("그래프 확대");
  await expect(zoom.locator("option")).toHaveText(["50%", "75%", "100%", "125%", "150%"]);
  await zoom.selectOption("50");
  await expect(svg).toHaveAttribute("data-zoom", "50");
  await zoom.selectOption("100");

  // 그래프 노드 클릭 → ?field_key=temperature, 노드 강조, 우측 필드 상세.
  await temperatureNode.click();
  await expect(page).toHaveURL(/field_key=temperature/);
  await expect(temperatureNode).toHaveAttribute("aria-pressed", "true");
  await expect(temperatureNode).toHaveClass(/\bselected\b/);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");
  await expect(detail.getByRole("button", { name: "선택 해제" })).toBeVisible();

  // 트리 보기로 복귀: view 파라미터 제거, 선택 노드가 트리에서도 강조된다.
  await viewToggle(page).getByRole("button", { name: "트리 보기" }).click();
  await expect(page).not.toHaveURL(/view=/);
  await expect(page).toHaveURL(/field_key=temperature/);
  await expect(treeItem(page, "온도")).toHaveAttribute("aria-selected", "true");
  await expect(treeItem(page, "온도")).toHaveClass(/\bselected\b/);
  await expect(tree(page).locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);

  // 필드 상세(온도): 영문명 temperature · decimal · °C · alias 칩 · 부모 공정 정보 · 관련 압력.
  const field = fieldDetail(page);
  await expect(kv(page, "필드명").locator(".app-chip")).toHaveText("활성");
  await expect(kv(page, "영문명").locator("code")).toHaveText("temperature");
  await expect(kv(page, "설명")).toHaveText("공정 설정 온도");
  await expect(kv(page, "타입")).toHaveText("decimal");
  await expect(kv(page, "단위")).toHaveText("°C");
  await expect(field.getByLabel("Alias").locator(".app-chip")).toHaveText(["온도값", "Temp"]);
  const relationList = field.locator('dl[aria-label="필드 관계"]');
  await expect(relationList.locator("dt")).toHaveText(["부모", "자식", "관련"]);
  await expect(relationList.locator("dd").nth(0).getByRole("button")).toHaveText(["공정 정보"]);
  await expect(relationList.locator("dd").nth(1)).toHaveText("없음");
  await expect(relationList.locator("dd").nth(2).getByRole("button")).toHaveText(["압력"]);
  await expect(field.getByRole("button", { name: "1개 보기 ›" })).toBeVisible();
  await expect(field.getByRole("button", { name: "3개 보기 ›" })).toBeVisible();
  // 관련 필드 링크 → 압력 상세(단위 bar, 관련 없음: related_to는 정의 방향만 기록된다), 부모 링크 → 그룹 상세(타입 group).
  await relationList.locator("dd").nth(2).getByRole("button", { name: "압력" }).click();
  await expect(page).toHaveURL(/field_key=pressure/);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("압력");
  await expect(kv(page, "영문명").locator("code")).toHaveText("pressure");
  await expect(kv(page, "단위")).toHaveText("bar");
  await expect(fieldDetail(page).getByLabel("Alias").locator(".app-chip")).toHaveText(["Pressure"]);
  await expect(treeItem(page, "압력")).toHaveAttribute("aria-selected", "true");
  await fieldDetail(page).locator('dl[aria-label="필드 관계"] dd').nth(0).getByRole("button", { name: "공정 정보" }).click();
  await expect(page).toHaveURL(/field_key=process/);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("공정 정보");
  await expect(kv(page, "타입")).toHaveText("group");
  await expect(fieldDetail(page).locator('dl[aria-label="필드 관계"] dd').nth(1).getByRole("button")).toHaveText(["공정명", "설비명", "배치", "측정일시", "온도", "압력", "시간"]);
  await expect(fieldDetail(page).getByRole("button", { name: "0개 보기 ›" })).toHaveCount(2);
  await expect(fieldDetail(page).getByRole("button", { name: "Source Review 열기" })).toBeDisabled();
  await expect(fieldDetail(page).getByRole("note")).toHaveText("아직 추출된 값이 없습니다. 이 필드를 쓰는 프로파일을 문서에 적용하면 원본을 열 수 있습니다.");
  // 트리에서 온도를 다시 고른다(Enter 키로도 선택된다).
  await treeItem(page, "온도").click();
  await expect(page).toHaveURL(/field_key=temperature/);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");

  // '사용 프로파일 1개 보기 ›' → 사용 프로파일 탭 + ?field_filter=temperature + 필터 표시줄, 행 [공정데이터_A양식 | v1 | 1 · temperature | 4 | 승인].
  await fieldDetail(page).getByRole("button", { name: "1개 보기 ›" }).click();
  await expect(page).toHaveURL(/tab=profiles/);
  await expect(page).toHaveURL(/field_filter=temperature/);
  await expect(tabs(page).getByRole("tab", { name: "사용 프로파일 (1)" })).toHaveAttribute("aria-selected", "true");
  await expect(viewToggle(page)).toHaveCount(0);
  const filterBar = detail.getByRole("status", { name: "필드 필터" });
  await expect(filterBar).toContainText("기준으로 거른 목록");
  await expect(filterBar.locator(".app-chip")).toHaveText("온도");
  const profiles = detail.getByRole("table", { name: "사용 프로파일" });
  await expect(profiles.getByRole("columnheader")).toHaveText(["프로파일명", "버전", "규칙", "적용 문서", "상태"]);
  await expect(profiles.locator("tbody tr")).toHaveCount(1);
  const profileRow = profiles.locator("tbody tr").first();
  await expect(profileRow.getByRole("cell").nth(0)).toHaveText(PROFILE_NAME);
  await expect(profileRow.getByRole("cell").nth(1)).toHaveText("v1");
  await expect(profileRow.getByRole("cell").nth(2)).toHaveText("1 · temperature");
  await expect(profileRow.getByRole("cell").nth(3)).toHaveText("4");
  await expect(profileRow.getByRole("cell").nth(4).locator(".app-chip")).toHaveText("승인");
  // 필터 해제 → 전체 규칙 11개(앞 5개 키만 표시).
  await filterBar.getByRole("button", { name: "필터 해제" }).click();
  await expect(page).not.toHaveURL(/field_filter=/);
  await expect(filterBar).toHaveCount(0);
  await expect(profiles.locator("tbody tr").first().getByRole("cell").nth(2)).toHaveText("11 · product_name, recipe_name, process_name, equipment, lot");
  // 필드 상세는 다른 탭에서도 유지된다.
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");

  // '연관 문서 3개 보기 ›' → 연관 문서 탭(field_filter): 발행된 문서 3건, 각 행에 프로파일 v1 · Snapshot 날짜 · 정상 · 원본 보기.
  await fieldDetail(page).getByRole("button", { name: "3개 보기 ›" }).click();
  await expect(page).toHaveURL(/tab=documents/);
  await expect(page).toHaveURL(/field_filter=temperature/);
  await expect(tabs(page).getByRole("tab", { name: "연관 문서 (4)" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByRole("status", { name: "필드 필터" }).locator(".app-chip")).toHaveText("온도");
  const documents = detail.getByRole("table", { name: "연관 문서" });
  await expect(documents.getByRole("columnheader")).toHaveText(["문서명", "사용 프로파일", "Snapshot", "상태", "원본 보기"]);
  await expect(documents.locator("tbody tr")).toHaveCount(3);
  await expect(documents.locator("tbody tr td:nth-child(1)")).toHaveText(PUBLISHED_DOCUMENTS);
  for (const name of PUBLISHED_DOCUMENTS) {
    const row = documents.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
    await expect(row.getByRole("cell").nth(1)).toHaveText(PROFILE_V1);
    await expect(row.getByRole("cell").nth(2)).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    await expect(row.getByRole("cell").nth(3).locator(".app-chip")).toHaveText("정상");
    await expect(row.getByRole("button", { name: "원본 보기" })).toBeEnabled();
  }
  // 필터 해제 → 스키마 전체 4건(검수 필요 문서 포함).
  await detail.getByRole("status", { name: "필드 필터" }).getByRole("button", { name: "필터 해제" }).click();
  await expect(documents.locator("tbody tr")).toHaveCount(4);
  const shiftedRow = documents.getByRole("row").filter({ has: page.getByRole("button", { name: SHIFTED, exact: true }) });
  await expect(shiftedRow.getByRole("cell").nth(3).locator(".app-chip")).toHaveText("검수 필요");
  await expect(shiftedRow.getByRole("button", { name: "원본 보기" })).toBeEnabled();
  // 화면 텍스트에 내부 ID(UUID·SHA-256)가 없다(§7 표시 규칙).
  const mainText = await page.locator("main").innerText();
  expect(mainText).not.toMatch(UUID);
  expect(mainText).not.toMatch(SHA256);

  // 최근 값: 마지막으로 발행된 문서(03)의 온도 5건(숫자) + 원본 위치 '공정 기록!C<행>'.
  const recent = fieldDetail(page).getByRole("list", { name: "최근 값" }).getByRole("listitem");
  await expect(recent).toHaveCount(5);
  const recentTexts = await recent.locator("strong").allInnerTexts();
  expect(recentTexts).toHaveLength(5);
  for (const text of recentTexts) expect(text).toMatch(/^\d+(\.\d+)?$/);
  for (const text of recentTexts) expect(Number(text)).toBeGreaterThanOrEqual(150);
  for (let i = 0; i < 5; i++) {
    await expect(recent.nth(i).locator("small")).toHaveText(new RegExp(`^${LATEST_DOCUMENT} · 공정 기록!C(9|1\\d|20) · (방금 전|\\d+분 전|\\d+시간 전)$`));
    await expect(recent.nth(i).getByRole("button", { name: "원본 보기" })).toBeVisible();
  }
  const valuesApi = await api(page, "GET", `/schemas/${SCHEMA_KEY}/fields/temperature/values?limit=5`);
  expect(valuesApi.status).toBe(200);
  expect(valuesApi.json.items).toHaveLength(5);
  const newest = valuesApi.json.items[0];
  expect(newest).toMatchObject({ rule_key: "temperature", document_name: LATEST_DOCUMENT, sheet_name: "공정 기록", unit_normalized: "°C" });
  expect(valuesApi.json.items.map((v: { text: string }) => v.text)).toEqual(recentTexts);

  // 'Source Review 열기' → 최신 값의 application/rule/sheet/range로 오버레이가 열린다(뒤 화면 inert).
  const openReview = fieldDetail(page).getByRole("button", { name: "Source Review 열기" });
  await expect(openReview).toBeEnabled();
  await expect(openReview).toHaveAttribute("title", `${LATEST_DOCUMENT} · 공정 기록!${newest.range}`);
  await openReview.click();
  await expect(page).toHaveURL(new RegExp(`review=${newest.application_id}`));
  await expect(page).toHaveURL(/rule=temperature/);
  await expect(page).toHaveURL(new RegExp(`sheet=${newest.sheet_id}`));
  await expect(page).toHaveURL(new RegExp(`range=${newest.range}(&|$)`));
  const review = page.getByRole("dialog", { name: "Source Review" });
  await expect(review).toBeVisible();
  await expect(review).toHaveAttribute("aria-modal", "true");
  await expect(page.locator("main")).toHaveAttribute("inert", "");
  const context = review.locator(".app-context").first();
  await expect(context.locator("strong")).toHaveText(LATEST_DOCUMENT);
  await expect(context).toContainText("/ 공정 기록");
  await expect(context).toContainText(`/ ${PROFILE_V1}`);
  await expect(context).toContainText(`/ ${SCHEMA_NAME} v1`);
  await expect(context.locator(".app-chip")).toHaveText(["발행됨", "승인 11/11", "동일"]);
  await expect(context.getByRole("button", { name: /^모두 승인/ })).toBeDisabled();
  // 좌: 규칙 목록에서 온도가 선택돼 있다. 우: 매핑 상세가 온도 필드(decimal · °C)와 추출값·원본 위치를 보여 준다.
  const ruleButton = review.getByRole("group", { name: "파싱 규칙 목록" }).getByRole("button", { name: /^온도 / });
  await expect(ruleButton).toHaveAttribute("aria-current", "true");
  await expect(ruleButton.locator(".app-chip")).toHaveText("승인");
  await expect(review.getByRole("group", { name: "시트 목록" }).getByRole("button", { name: /공정 기록/ })).toHaveAttribute("aria-current", "true");
  const panel = review.getByRole("region", { name: "매핑 상세" });
  await expect(panel.getByRole("heading", { level: 3 })).toHaveText("온도");
  await expect(panel.getByTestId("mapping-panel")).toHaveAttribute("data-mapping-status", "approved");
  const panelKv = panel.locator("dl.app-kv").first();
  await expect(panelKv.locator("dt")).toHaveText(["필드", "파싱 규칙", "관찰된 키", "추출값", "원본 위치", "상태"]);
  const panelValue = (term: string) => panelKv.locator("dt", { hasText: new RegExp(`^${term}$`) }).locator("xpath=following-sibling::dd[1]");
  await expect(panelValue("필드").locator("strong")).toHaveText("온도");
  await expect(panelValue("필드")).toContainText("decimal · °C");
  await expect(panelValue("파싱 규칙")).toHaveText("온도");
  await expect(panelValue("추출값").locator("strong")).toHaveText("150 °C");
  await expect(panelValue("추출값")).toContainText("값 12개 중 첫 값");
  await expect(panelValue("추출값")).toContainText("공정 기록!C9");
  await expect(panelValue("원본 위치").getByRole("button")).toHaveText(["키: 공정 기록!C8", "값: 공정 기록!C9:C68", "단위: 공통 정보!B1"]);
  await expect(panelValue("상태")).toContainText("승인");
  // 중앙 뷰어: 실제 셀 + key/value overlay 사각형(원본 위치 기준).
  const cell = (ref: string) => review.locator(`.app-cell[data-ref="${ref}"]`);
  await expect(cell("C8")).toHaveText("온도", { timeout: 60_000 });
  await expect(cell("C9")).toHaveText("150");
  await expect(cell(newest.range)).toHaveText(newest.text);
  const overlayRects = review.locator(".app-overlay");
  await expect(overlayRects).toHaveCount(2);
  await expect(review.locator('.app-overlay.key[data-range="C8"]')).toHaveCount(1);
  await expect(review.locator('.app-overlay.key[data-range="C8"] .app-overlay-label')).toHaveText("키");
  await expect(review.locator('.app-overlay.value[data-range="C9:C68"]')).toHaveCount(1);
  await expect(review.locator('.app-overlay.value[data-range="C9:C68"] .app-overlay-label')).toHaveText("값");
  const keyBox = await review.locator('.app-overlay.key[data-range="C8"]').boundingBox();
  const c8Box = await cell("C8").boundingBox();
  expect(keyBox && c8Box && Math.abs(keyBox.x - c8Box.x) < 6 && Math.abs(keyBox.y - c8Box.y) < 6, `overlay ${JSON.stringify(keyBox)} vs cell ${JSON.stringify(c8Box)}`).toBe(true);
  const reviewText = await review.innerText();
  expect(reviewText).not.toMatch(UUID);
  // 단위 위치를 누르면 공통 정보 시트로 이동해 unit overlay가 보인다.
  await panelValue("원본 위치").getByRole("button", { name: "단위: 공통 정보!B1" }).click();
  await expect(page).toHaveURL(/range=B1/);
  await expect(review.getByRole("group", { name: "시트 목록" }).getByRole("button", { name: /공통 정보/ })).toHaveAttribute("aria-current", "true");
  await expect(cell("B1")).toHaveText("°C", { timeout: 60_000 });
  await expect(review.locator('.app-overlay.unit[data-range="B1"]')).toHaveCount(1);
  await expect(review.locator(".app-overlay")).toHaveCount(1);

  // ← 돌아가기 → 오버레이 닫힘, review·rule·range 제거, 스키마 화면(연관 문서 탭 + 온도 필드 상세)은 그대로.
  await review.getByRole("button", { name: "← 돌아가기" }).click();
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  await expect(page).not.toHaveURL(/rule=/);
  await expect(page).not.toHaveURL(/range=/);
  await expect(page).toHaveURL(/screen=schema/);
  await expect(page).toHaveURL(/tab=documents/);
  await expect(page).toHaveURL(/field_key=temperature/);
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");
  await expect(detail.getByRole("table", { name: "연관 문서" }).locator("tbody tr")).toHaveCount(4);
  // 연관 문서 행의 '원본 보기'도 같은 오버레이를 연다(rule 없이 첫 규칙).
  await shiftedRow.getByRole("button", { name: "원본 보기" }).click();
  await expect(page).toHaveURL(/review=[0-9a-f-]{36}/);
  await expect(review).toBeVisible();
  await expect(review.locator(".app-context").first().locator("strong")).toHaveText(SHIFTED);
  await expect(review.locator(".app-context").first().locator(".app-chip")).toHaveText(["미발행", "승인 0/11", "호환"]);
  await review.press("Escape");
  await expect(review).toHaveCount(0);
  await expect(page).not.toHaveURL(/review=/);
  errors.assertClean();
});

test("필드 편집(alias 추가 → PATCH → 새 리비전) · 변경 이력", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoSchema(page, "&field_key=temperature&tab=history");
  const detail = schemaDetail(page);
  await expect(tabs(page).getByRole("tab", { name: "변경 이력" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByText("정의 파일 리비전. 필드 편집·필드 삭제도 새 리비전을 만듭니다. 새 리비전은 위 '새 리비전' 버튼으로 올립니다.")).toBeVisible();
  // 쓰기 버튼은 상세 머리에 모여 있다(새 리비전 · 이름 바꾸기). '삭제'는 쓰는 프로파일·적용 기록이 있으면
  // 아예 그리지 않는다 — 서버가 반드시 409로 막으므로 언제나 실패하는 버튼이 되기 때문이다(§4.2.1).
  await expect(detail.locator(".app-card-head").getByRole("button", { name: "새 리비전", exact: true })).toBeVisible();
  await expect(detail.locator(".app-card-head").getByRole("button", { name: "이름 바꾸기" })).toBeVisible();
  await expect(detail.locator(".app-card-head").getByRole("button", { name: "삭제" })).toHaveCount(0);
  const history = detail.getByRole("table", { name: "변경 이력" });
  await expect(history.getByRole("columnheader")).toHaveText(["버전", "일시", "필드"]);
  await expect(history.locator("tbody tr")).toHaveCount(1);
  await expect(history.locator("tbody tr").first().getByRole("cell").nth(0)).toContainText("v1");
  await expect(history.locator("tbody tr").first().locator(".app-chip")).toHaveText("현재");
  await expect(history.locator("tbody tr").first().getByRole("cell").nth(1)).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  const before = await api(page, "GET", `/schemas/${SCHEMA_KEY}/revisions`);
  expect(before.json.items.map((r: { rev: number; current: boolean; field_count: number }) => [r.rev, r.current, r.field_count])).toEqual([[1, true, 14]]);

  // 편집 폼: 기존 값이 채워져 있고, 바뀐 항목이 없으면 저장이 비활성.
  const field = fieldDetail(page);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");
  await expect(field.getByLabel("Alias").locator(".app-chip")).toHaveText(["온도값", "Temp"]);
  await field.getByRole("button", { name: "편집" }).click();
  const form = field.getByRole("form", { name: "필드 편집" });
  await expect(form).toBeVisible();
  await expect(form.getByLabel("필드명")).toHaveValue("온도");
  await expect(form.getByLabel("설명")).toHaveValue("공정 설정 온도");
  await expect(form.getByLabel("Alias")).toHaveValue("온도값, Temp");
  await expect(form.getByLabel("상태")).toHaveValue("active");
  await expect(form.getByRole("button", { name: "저장" })).toBeDisabled();
  // 필드명을 비우면 저장 불가(aria-invalid), 되돌리면 다시 비활성(변경 없음).
  await form.getByLabel("필드명").fill("");
  await expect(form.getByLabel("필드명")).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("button", { name: "저장" })).toBeDisabled();
  await form.getByLabel("필드명").fill("온도");
  await expect(form.getByRole("button", { name: "저장" })).toBeDisabled();
  // 취소는 폼을 닫고 아무것도 바꾸지 않는다.
  await form.getByLabel("Alias").fill("온도값, Temp, 취소될값");
  await expect(form.getByRole("button", { name: "저장" })).toBeEnabled();
  await form.getByRole("button", { name: "취소" }).click();
  await expect(form).toHaveCount(0);
  await expect(field.getByLabel("Alias").locator(".app-chip")).toHaveText(["온도값", "Temp"]);

  // alias '온도값2' 추가 → PATCH {aliases:[...]} 1회 → 칩 추가 + 토스트.
  await field.getByRole("button", { name: "편집" }).click();
  await form.getByLabel("Alias").fill("온도값, Temp, 온도값2");
  const patchRequest = page.waitForRequest((request) => request.method() === "PATCH" && request.url().includes(`/api/schemas/${SCHEMA_KEY}/fields/temperature`));
  const patchResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/schemas/${SCHEMA_KEY}/fields/temperature`));
  await form.getByRole("button", { name: "저장" }).click();
  const request = await patchRequest;
  expect(request.postDataJSON()).toEqual({ aliases: ["온도값", "Temp", "온도값2"] });
  const response = await patchResponse;
  expect(response.status()).toBe(200);
  // §6 B: PATCH 응답은 GET과 같은 필드 상세다(가져오기 요약이 아니다) — 화면은 이 응답만으로 갱신한다.
  expect(await response.json()).toMatchObject({
    field_key: "temperature",
    name: "온도",
    type: "decimal",
    unit: "°C",
    aliases: ["온도값", "Temp", "온도값2"],
    parents: ["process"],
    related: ["pressure"],
    status: "active",
    schema: { key: SCHEMA_KEY, name: SCHEMA_NAME, rev: 2 },
  });
  await expect(page.locator(".app-toast").filter({ hasText: "온도 필드 저장됨" })).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(field.getByLabel("Alias").locator(".app-chip")).toHaveText(["온도값", "Temp", "온도값2"]);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");
  await expect(kv(page, "단위")).toHaveText("°C");
  // 저장 뒤 스키마 헤더가 새 리비전(v2)을 보여 준다.
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(`${SCHEMA_NAME} v2`);
  await expect(detail.locator(".app-card-head .app-muted")).toHaveText("필드 14 · 프로파일 1 · 문서 4");

  // API: 필드에 alias가 붙었고, 정의 파일 리비전이 r2(현재)·r1로 늘었다(필드 편집 = 새 리비전).
  const patched = await api(page, "GET", `/schemas/${SCHEMA_KEY}/fields/temperature`);
  expect(patched.json.aliases).toEqual(["온도값", "Temp", "온도값2"]);
  expect(patched.json).toMatchObject({ name: "온도", type: "decimal", unit: "°C", parents: ["process"], related: ["pressure"], status: "active" });
  const schema = await api(page, "GET", `/schemas/${SCHEMA_KEY}`);
  expect(schema.json).toMatchObject({ current_rev: 2, field_count: 14, profile_count: 1, document_count: 4 });
  const after = await api(page, "GET", `/schemas/${SCHEMA_KEY}/revisions`);
  expect(after.json.items.map((r: { rev: number; current: boolean; field_count: number }) => [r.rev, r.current, r.field_count])).toEqual([
    [2, true, 14],
    [1, false, 14],
  ]);

  // 변경 이력 표도 r2(현재)·r1 두 줄이 된다.
  await expect(history.locator("tbody tr")).toHaveCount(2);
  await expect(history.locator("tbody tr").nth(0).getByRole("cell").nth(0)).toContainText("v2");
  await expect(history.locator("tbody tr").nth(0).locator(".app-chip")).toHaveText("현재");
  await expect(history.locator("tbody tr").nth(1).getByRole("cell").nth(0)).toContainText("v1");
  await expect(history.locator("tbody tr").nth(1).locator(".app-chip")).toHaveCount(0);
  await expect(history.locator(".app-chip")).toHaveCount(1);
  // 트리·목록도 새 alias를 반영한 상태로 다시 읽힌다(구조 보기 복귀, 온도 선택 유지).
  await tabs(page).getByRole("tab", { name: "구조 보기" }).click();
  await expect(page).not.toHaveURL(/tab=/);
  await expect(treeItem(page, "온도")).toHaveAttribute("aria-selected", "true");
  await expect(schemaList(page).getByRole("button", { name: new RegExp(SCHEMA_NAME) }).locator("small")).toHaveText("필드 14 · 프로파일 1 · 문서 4");
  // 새로 고침 뒤에도 서버 상태(v2 · alias 3개)가 그대로다.
  await page.reload();
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(`${SCHEMA_NAME} v2`);
  await expect(fieldDetail(page).getByLabel("Alias").locator(".app-chip")).toHaveText(["온도값", "Temp", "온도값2"]);
  const mainText = await page.locator("main").innerText();
  expect(mainText).not.toMatch(UUID);
  errors.assertClean();
});

test("새 스키마 생성(생성 전용) · 같은 키 재생성 거부 · 필드 추가/삭제 · 사용 중 필드·스키마 삭제 거부", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoSchema(page);
  const detail = schemaDetail(page);
  const list = schemaList(page);

  // ---- 새 스키마(생성 전용): 정의 JSON을 붙여넣어 만든다.
  await page.getByRole("button", { name: "새 스키마", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "새 스키마" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  // 대화상자가 열린 동안 뒤 화면은 inert(스키마 화면은 main 안쪽 래퍼에 건다).
  await expect(page.locator("main [inert]")).toHaveCount(1);
  await expect(dialog).toContainText("이미 있는 스키마 키는 만들 수 없습니다 — 그 스키마를 열어 '새 리비전'을 쓰세요.");
  const definition = dialog.getByLabel("정의 JSON");
  // 깨진 JSON은 저장 불가.
  await definition.fill("{ nope");
  await expect(dialog.getByRole("alert")).toHaveText("JSON을 해석할 수 없습니다.");
  await expect(dialog.getByRole("button", { name: "가져오기" })).toBeDisabled();
  await definition.fill(JSON.stringify(NEW_SCHEMA, null, 2));
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("정의 요약")).toHaveText(`${NEW_SCHEMA_NAME} (${NEW_SCHEMA_KEY}) · 필드 2`);
  const createRequest = page.waitForRequest((r) => r.method() === "POST" && /\/api\/schemas$/.test(r.url()));
  await dialog.getByRole("button", { name: "가져오기" }).click();
  expect((await createRequest).postDataJSON()).toEqual({ definition: NEW_SCHEMA });
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: `${NEW_SCHEMA_NAME} v1 저장됨` })).toBeVisible();
  // 목록 2건 · 새 스키마가 선택되고 트리에 필드 2개.
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (2)");
  await expect(page).toHaveURL(new RegExp(`schema=${NEW_SCHEMA_KEY}`));
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(`${NEW_SCHEMA_NAME} v1`);
  await expect(detail.locator(".app-card-head .app-muted")).toHaveText("필드 2 · 프로파일 0 · 문서 0");
  await expect(tree(page).locator('[role="treeitem"]')).toHaveCount(2);
  await expect(tree(page).locator('[role="treeitem"] .app-tree-name')).toHaveText(["표본 그룹", "표본 값"]);

  // ---- 같은 키로 다시 만들면 409 SCHEMA_EXISTS: 대화상자에 서버 문구가 그대로 뜨고 아무것도 쓰이지 않는다.
  await page.getByRole("button", { name: "새 스키마", exact: true }).click();
  const again = page.getByRole("dialog", { name: "새 스키마" });
  await again.getByLabel("정의 JSON").fill(JSON.stringify({ ...NEW_SCHEMA, schema_name: "이름만 바꾼 정의" }, null, 2));
  const conflict = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\/schemas$/.test(r.url()));
  await again.getByRole("button", { name: "가져오기" }).click();
  const conflictResponse = await conflict;
  expect(conflictResponse.status()).toBe(409);
  expect((await conflictResponse.json()).error.code).toBe("SCHEMA_EXISTS");
  await expect(again.getByRole("alert")).toHaveText(SCHEMA_EXISTS_MESSAGE);
  await expect(again).toBeVisible();
  await again.getByRole("button", { name: "취소" }).click();
  await expect(again).toHaveCount(0);
  // 거부된 생성은 리비전도 이름도 바꾸지 않았다.
  const untouched = await api(page, "GET", `/schemas/${NEW_SCHEMA_KEY}`);
  expect(untouched.json).toMatchObject({ schema_name: NEW_SCHEMA_NAME, current_rev: 1, field_count: 2 });
  expect((await api(page, "GET", `/schemas/${NEW_SCHEMA_KEY}/revisions`)).json.items).toHaveLength(1);

  // ---- 필드 추가(= 새 리비전): 타입 목록은 계약의 어휘(text/decimal/…)와 같다.
  await detail.getByRole("button", { name: "+ 필드 추가" }).click();
  const fieldDialog = page.getByRole("dialog", { name: "필드 추가" });
  await expect(fieldDialog.getByLabel("타입").locator("option")).toHaveText(["text", "decimal", "boolean", "date", "datetime", "group"]);
  await fieldDialog.getByLabel("영문 키").fill(TEMP_FIELD_KEY);
  await fieldDialog.getByLabel("필드명").fill(TEMP_FIELD_NAME);
  await fieldDialog.getByLabel("타입").selectOption("decimal");
  await fieldDialog.getByLabel("단위").fill("mm");
  await fieldDialog.getByLabel("상위 필드").selectOption("sample_group");
  const createField = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/schemas/${NEW_SCHEMA_KEY}/fields`));
  await fieldDialog.getByRole("button", { name: "추가" }).click();
  const createdField = await createField;
  expect(createdField.status()).toBe(201);
  // §6 B: 생성 응답도 필드 상세다(저장 뒤 rev).
  expect(await createdField.json()).toMatchObject({ field_key: TEMP_FIELD_KEY, name: TEMP_FIELD_NAME, type: "decimal", unit: "mm", parents: ["sample_group"], schema: { key: NEW_SCHEMA_KEY, rev: 2 } });
  await expect(fieldDialog).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: `${TEMP_FIELD_NAME} 필드 저장됨` })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(`${NEW_SCHEMA_NAME} v2`);
  await expect(tree(page).locator('[role="treeitem"]')).toHaveCount(3);
  await expect(page).toHaveURL(new RegExp(`field_key=${TEMP_FIELD_KEY}`));
  await expect(kv(page, "필드명").locator("strong")).toHaveText(TEMP_FIELD_NAME);

  // ---- 쓰지 않는 필드 삭제: 확인 문구 → 새 리비전(v3) · 토스트 · 트리에서 사라진다.
  await fieldDetail(page).getByRole("button", { name: "삭제" }).click();
  const deleteField = page.getByRole("dialog", { name: "필드 삭제" });
  await expect(deleteField.getByRole("heading", { level: 2, name: "필드 삭제" })).toBeVisible();
  await expect(deleteField).toContainText(`'${TEMP_FIELD_NAME}' 필드를 지운 새 리비전을 저장합니다.`);
  await expect(deleteField.getByRole("button", { name: "취소" })).toBeVisible();
  const fieldDeleted = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/fields/${TEMP_FIELD_KEY}`));
  await deleteField.getByRole("button", { name: "삭제", exact: true }).click();
  const deletedBody = await (await fieldDeleted).json();
  expect(deletedBody).toEqual({ schema_key: NEW_SCHEMA_KEY, field_key: TEMP_FIELD_KEY, name: TEMP_FIELD_NAME, current_rev: 3, fields_remaining: 2 });
  await expect(deleteField).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: `'${TEMP_FIELD_NAME}' 필드를 지웠습니다 · v3` })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(`${NEW_SCHEMA_NAME} v3`);
  await expect(tree(page).locator('[role="treeitem"]')).toHaveCount(2);
  await expect(page).not.toHaveURL(/field_key=/);
  expect((await api(page, "GET", `/schemas/${NEW_SCHEMA_KEY}/fields/${TEMP_FIELD_KEY}`)).status).toBe(404);

  // ---- 자식이 있는 필드는 지울 수 없다(FIELD_HAS_CHILDREN): 모달은 열린 채 '하위 필드 보기'가 붙는다.
  await gotoSchema(page, "&field_key=process");
  await expect(kv(page, "필드명").locator("strong")).toHaveText("공정 정보");
  await fieldDetail(page).getByRole("button", { name: "삭제" }).click();
  const hasChildren = page.getByRole("dialog", { name: "필드 삭제" });
  await hasChildren.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(hasChildren.getByRole("alert")).toContainText("하위 필드 7개(공정명, 설비명, 배치 외)를 먼저 지우세요.");
  await expect(hasChildren.getByRole("list", { name: "하위 필드" }).getByRole("listitem")).toHaveText([
    "공정명",
    "설비명",
    "배치",
    "측정일시",
    "온도",
    "압력",
    "시간",
  ]);
  await expect(hasChildren.getByRole("button", { name: "삭제", exact: true })).toBeDisabled();
  await hasChildren.getByRole("button", { name: "하위 필드 보기" }).click();
  await expect(hasChildren).toHaveCount(0);
  await expect(page).toHaveURL(/field_key=process_name/);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("공정명");

  // ---- 쓰는 규칙·추출값이 있는 필드도 지울 수 없다(FIELD_IN_USE): '사용 프로파일 보기'로 근거를 보여 준다.
  await page.goto(`/?screen=schema&schema=${SCHEMA_KEY}&field_key=temperature`);
  await expect(kv(page, "필드명").locator("strong")).toHaveText("온도");
  const revisionsBefore = (await api(page, "GET", `/schemas/${SCHEMA_KEY}/revisions`)).json.items.length;
  await fieldDetail(page).getByRole("button", { name: "삭제" }).click();
  const inUseField = page.getByRole("dialog", { name: "필드 삭제" });
  const fieldRefused = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith("/fields/temperature"));
  await inUseField.getByRole("button", { name: "삭제", exact: true }).click();
  const fieldRefusedBody = await (await fieldRefused).json();
  expect((await fieldRefused).status()).toBe(409);
  expect(fieldRefusedBody.error.code).toBe("FIELD_IN_USE");
  expect(fieldRefusedBody.error.detail.profiles[0]).toMatchObject({ profile_name: PROFILE_NAME, rule_keys: ["temperature"] });
  await expect(inUseField.getByRole("alert")).toContainText(`이 필드는 프로파일 1개(${PROFILE_NAME} 규칙 temperature)가 쓰고 있고 추출값이`);
  await expect(inUseField.getByRole("alert")).toContainText("프로파일 정의에서 이 필드를 쓰는 규칙을 뺀 새 리비전을 저장한 뒤 다시 시도하세요.");
  await expect(inUseField.getByRole("list", { name: "사용 프로파일" }).getByRole("listitem").first()).toContainText(PROFILE_NAME);
  await inUseField.getByRole("button", { name: "사용 프로파일 보기" }).click();
  await expect(inUseField).toHaveCount(0);
  await expect(page).toHaveURL(/tab=profiles/);
  await expect(page).toHaveURL(/field_filter=temperature/);
  await expect(detail.getByRole("table", { name: "사용 프로파일" }).locator("tbody tr")).toHaveCount(1);
  // 거부된 삭제는 아무것도 쓰지 않았다(필드도 리비전 수도 그대로).
  expect((await api(page, "GET", `/schemas/${SCHEMA_KEY}/fields/temperature`)).status).toBe(200);
  expect((await api(page, "GET", `/schemas/${SCHEMA_KEY}/revisions`)).json.items).toHaveLength(revisionsBefore);

  // ---- 쓰는 프로파일이 있는 스키마에는 '삭제' 버튼이 없다. 눌러도 반드시 실패하는 버튼을 두지 않는다(§4.2.1).
  await expect(detail.locator(".app-card-head").getByRole("button", { name: "삭제" })).toHaveCount(0);
  // 서버도 같은 기준으로 막고, 그 문구는 실제로 가능한 행동(프로파일 삭제)만 말한다.
  const schemaRefused = await api(page, "DELETE", `/schemas/${SCHEMA_KEY}`);
  expect(schemaRefused.status).toBe(409);
  expect(schemaRefused.json.error.code).toBe("SCHEMA_IN_USE");
  expect(schemaRefused.json.error.detail).toMatchObject({ profile_count: 1, document_count: 4 });
  expect(schemaRefused.json.error.message).toContain(`이 스키마는 파싱 프로파일 1개(${PROFILE_NAME})가 쓰고 있고 적용된 문서가 4개입니다.`);
  // §4.2.1: 지울 수 없을 때 가능한 행동 둘을 말한다 — 프로파일을 지우거나, 더 쓰지 않으려면 스키마를 '폐기'한다.
  expect(schemaRefused.json.error.message).toContain("프로파일 상세에서 '삭제'한 뒤 다시 시도하거나, 더 쓰지 않으려면 이 스키마를 '폐기'하세요.");
  // 그 프로파일도 적용된 문서가 있어 지울 수 없다 — 그때 가능한 행동('폐기')만 안내한다.
  const profileRefused = await api(page, "DELETE", `/profiles/${(await api(page, "GET", "/profiles")).json.items[0].profile_id}`);
  expect(profileRefused.status).toBe(409);
  expect(profileRefused.json.error.code).toBe("PROFILE_IN_USE");
  expect(profileRefused.json.error.message).toContain("더 쓰지 않으려면 '폐기'하세요.");
  expect((await api(page, "GET", `/schemas/${SCHEMA_KEY}`)).status).toBe(200);
  await page.goto(`/?screen=schema&schema=${SCHEMA_KEY}&tab=profiles`);
  await expect(page).toHaveURL(/tab=profiles/);

  // ---- 아무도 쓰지 않는 스키마는 지워진다: 목록에서 사라지고 정의도 404.
  await page.goto(`/?screen=schema&schema=${NEW_SCHEMA_KEY}`);
  await expect(detail.getByRole("heading", { level: 2 })).toContainText(NEW_SCHEMA_NAME);
  await detail.locator(".app-card-head").getByRole("button", { name: "삭제" }).click();
  const removeSchema = page.getByRole("dialog", { name: "스키마 삭제" });
  await expect(removeSchema).toContainText(`'${NEW_SCHEMA_NAME}'과(와) 필드 2개를 지웁니다. 되돌릴 수 없습니다.`);
  const removed = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().endsWith(`/api/schemas/${NEW_SCHEMA_KEY}`));
  await removeSchema.getByRole("button", { name: "삭제", exact: true }).click();
  const removedBody = await (await removed).json();
  expect((await removed).status()).toBe(200);
  expect(removedBody).toMatchObject({ schema_key: NEW_SCHEMA_KEY, schema_name: NEW_SCHEMA_NAME, deleted: { fields: 2, revisions: 3 } });
  await expect(removeSchema).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: `'${NEW_SCHEMA_NAME}' 스키마를 지웠습니다.` })).toBeVisible();
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (1)");
  await expect(list.getByRole("button", { name: new RegExp(NEW_SCHEMA_NAME) })).toHaveCount(0);
  expect((await api(page, "GET", `/schemas/${NEW_SCHEMA_KEY}`)).status).toBe(404);
  expect((await api(page, "GET", "/schemas")).json.items.map((s: { schema_key: string }) => s.schema_key)).toEqual([SCHEMA_KEY]);
  const mainText = await page.locator("main").innerText();
  expect(mainText).not.toMatch(UUID);
  // 화면에서 일부러 거부시킨 409 두 건(SCHEMA_EXISTS · FIELD_HAS_CHILDREN · FIELD_IN_USE)은 브라우저가 리소스 오류로 남긴다.
  // SCHEMA_IN_USE·PROFILE_IN_USE는 화면에 버튼이 없어 page.request로 확인했으므로 콘솔에 남지 않는다.
  const conflicts = errors.errors.filter((e) => e.includes("409 (Conflict)"));
  expect(conflicts, "거부된 요청 수만큼의 409 리소스 오류").toHaveLength(3);
  errors.errors.splice(0, errors.errors.length, ...errors.errors.filter((e) => !e.includes("409 (Conflict)")));
  errors.assertClean();
});

test("스키마 폐기 → 목록 기본(활성)에서 사라짐 → 상태 필터 · 새 프로파일/데이터 빌드 선택에서 빠짐 → 폐기 해제", async ({ page }) => {
  const errors = collectErrors(page);
  await gotoSchema(page, `&schema=${SCHEMA_KEY}`);
  const detail = schemaDetail(page);
  const list = schemaList(page);
  const head = detail.locator(".app-card-head");

  // ---- 시작 상태: 활성 칩 · '폐기' 버튼 하나(폐기 해제는 없다) · 쓰는 프로파일이 있어 '삭제'는 없다.
  await expect(head.locator(".app-chip").first()).toHaveText("활성");
  await expect(head.locator(".app-chip").first()).toHaveClass(/\bok\b/);
  await expect(head.getByRole("button", { name: "폐기", exact: true })).toHaveCount(1);
  await expect(head.getByRole("button", { name: "폐기 해제" })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "삭제" })).toHaveCount(0);
  await expect(detail.getByText("폐기된 스키마입니다.", { exact: false })).toHaveCount(0);

  // ---- '폐기' → 확인 대화상자(§4.2.3 문구 그대로, 주 행동은 '폐기').
  await head.getByRole("button", { name: "폐기", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "스키마 폐기" });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("heading", { level: 2, name: "스키마 폐기" })).toBeVisible();
  await expect(
    confirm.getByText(
      `'${SCHEMA_NAME}'을(를) 폐기합니다. 새 파싱 프로파일을 이 스키마에 만들 수 없게 되고 목록 기본에서 숨깁니다. 이미 있는 프로파일·적용 건·추출값은 그대로이며 언제든 '폐기 해제'할 수 있습니다.`,
    ),
  ).toBeVisible();
  await expect(confirm.getByRole("button", { name: "폐기", exact: true })).toBeEnabled();
  // 취소하면 상태가 그대로다.
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(head.locator(".app-chip").first()).toHaveText("활성");

  await head.getByRole("button", { name: "폐기", exact: true }).click();
  const deprecated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/schemas/${SCHEMA_KEY}/deprecate`));
  await confirm.getByRole("button", { name: "폐기", exact: true }).click();
  const deprecateResponse = await deprecated;
  expect(deprecateResponse.status()).toBe(200);
  // 응답은 GET /schemas/{key}와 같은 형태다 — 화면이 이 하나로 헤더·칩·버튼을 갱신한다(요약을 돌려주지 않는다).
  const deprecateBody = await deprecateResponse.json();
  expect(deprecateBody).toMatchObject({ schema_key: SCHEMA_KEY, schema_name: SCHEMA_NAME, status: "deprecated", profile_count: 1 });
  expect(deprecateBody.application_count).toBeGreaterThan(0);
  expect(Array.isArray(deprecateBody.fields)).toBe(true);
  expect(deprecateBody).toEqual((await api(page, "GET", `/schemas/${SCHEMA_KEY}`)).json);
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(".app-toast").filter({ hasText: `'${SCHEMA_NAME}' 스키마를 폐기했습니다.` })).toBeVisible();

  // ---- 상세: 폐기 칩 · 안내 한 줄 · 버튼이 '폐기 해제' 하나로 바뀐다.
  await expect(head.locator(".app-chip").first()).toHaveText("폐기");
  await expect(head.locator(".app-chip").first()).toHaveClass(/\bmuted\b/);
  await expect(head.getByRole("button", { name: "폐기", exact: true })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "폐기 해제" })).toHaveCount(1);
  await expect(
    detail.getByText("폐기된 스키마입니다. 이미 승인된 파싱 프로파일은 새 문서에 계속 적용됩니다 — 멈추려면 프로파일을 폐기하세요."),
  ).toBeVisible();

  // ---- 목록 기본(활성)에서 사라지고, 상태 필터로 다시 보인다.
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (0)");
  // 기본값인 '활성'도 필터다 — 하나뿐인 스키마를 폐기했다고 '스키마가 통째로 없다'고 말하면 같은 스키마를 다시 만들게 된다.
  await expect(
    list.getByText("활성 파싱 스키마가 없습니다. 폐기한 스키마는 상태를 '폐기'로 바꿔 보고 '폐기 해제'할 수 있습니다."),
  ).toBeVisible();
  await expect(list.getByRole("button", { name: "새 스키마" })).toHaveCount(0);
  await expect(list.getByRole("button", { name: "폐기된 스키마 보기" })).toHaveCount(1);
  const statusFilter = list.getByLabel("상태");
  await expect(statusFilter.locator("option")).toHaveText(["활성", "폐기", "전체"]);
  await expect(statusFilter).toHaveValue("active");
  await statusFilter.selectOption("deprecated");
  await expect(page).toHaveURL(/schema_status=deprecated/);
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (1)");
  const item = list.getByRole("button", { name: new RegExp(SCHEMA_NAME) });
  await expect(item).toHaveCount(1);
  await expect(item.locator(".app-chip")).toHaveText("폐기");
  await statusFilter.selectOption("all");
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (1)");
  // API도 같은 기준이다: 기본은 활성만.
  expect((await api(page, "GET", "/schemas")).json.items).toHaveLength(0);
  expect((await api(page, "GET", "/schemas?status=deprecated")).json.items.map((s: { schema_key: string }) => s.schema_key)).toEqual([SCHEMA_KEY]);
  expect((await api(page, "GET", "/schemas?status=all")).json.items).toHaveLength(1);

  // ---- 기존 프로파일·적용 건·추출값은 그대로다(폐기는 지우는 일이 아니다).
  const profiles = await api(page, "GET", `/profiles?schema_key=${SCHEMA_KEY}`);
  expect(profiles.json.items).toHaveLength(1);
  expect(profiles.json.items[0]).toMatchObject({ profile_name: PROFILE_NAME, status: "approved" });
  expect((await api(page, "GET", `/schemas/${SCHEMA_KEY}/documents`)).json.items.length).toBeGreaterThan(0);

  // ---- '새 프로파일' 대화상자의 스키마 선택에서 빠진다.
  await openScreen(page, "파싱 프로파일");
  await page.getByRole("button", { name: "+ 새 프로파일" }).click();
  const profileDialog = page.getByRole("dialog", { name: "새 프로파일" });
  await expect(profileDialog.getByLabel("파싱 스키마").locator("option")).toHaveText(["스키마 없음"]);
  await profileDialog.getByRole("button", { name: "취소" }).click();
  await expect(profileDialog).toHaveCount(0);
  // 서버도 막는다(422 SCHEMA_DEPRECATED) — 무엇을 하면 되는지 말한다.
  const refusedProfile = await api(page, "POST", "/profiles", {
    name: "폐기 스키마 프로파일",
    schema_key: SCHEMA_KEY,
    definition: { format: "parsing-profile", schema_version: "3.0", profile_name: "폐기 스키마 프로파일", schema_key: SCHEMA_KEY, rules: [] },
  });
  expect(refusedProfile.status).toBe(422);
  expect(refusedProfile.json.error.code).toBe("SCHEMA_DEPRECATED");
  expect(refusedProfile.json.error.message).toBe(
    "폐기된 파싱 스키마에는 새 프로파일을 만들 수 없습니다. 스키마 상세에서 '폐기 해제'한 뒤 다시 시도하세요.",
  );
  expect((await api(page, "GET", "/profiles")).json.items).toHaveLength(1);

  // ---- 데이터 빌드 2단계의 스키마 선택에서도 빠진다.
  await openScreen(page, "문서");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();
  for (const name of PUBLISHED_DOCUMENTS.slice(0, 2)) await page.getByRole("checkbox", { name: `${name} 선택` }).check();
  const selection = page.getByRole("region", { name: "선택한 문서" });
  await expect(selection).toContainText("2개 선택");
  await selection.getByRole("button", { name: "데이터 빌드에 추가" }).click();
  await page.locator(".app-toast").filter({ hasText: "데이터 빌드로 이동 ›" }).getByRole("button", { name: "데이터 빌드로 이동" }).click();
  await expect(page).toHaveURL(/screen=build/);
  await expect(page.getByRole("heading", { level: 2, name: /^입력 문서 2개/ })).toBeVisible();
  await page.getByRole("button", { name: "다음: 스키마" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "파싱 스키마 선택" })).toBeVisible();
  await expect(page.getByLabel("파싱 스키마").locator("option")).toHaveText(["선택하세요"]);

  // ---- '폐기 해제'는 확인 없이 바로(되돌릴 수 있는 일이다).
  await page.goto(`/?screen=schema&schema=${SCHEMA_KEY}&schema_status=deprecated`);
  await expect(head.locator(".app-chip").first()).toHaveText("폐기");
  const activated = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/schemas/${SCHEMA_KEY}/activate`));
  await head.getByRole("button", { name: "폐기 해제" }).click();
  expect((await activated).status()).toBe(200);
  expect(await (await activated).json()).toMatchObject({ schema_key: SCHEMA_KEY, status: "active" });
  await expect(page.getByRole("dialog")).toHaveCount(0); // 확인 대화상자를 거치지 않는다
  await expect(page.locator(".app-toast").filter({ hasText: `'${SCHEMA_NAME}' 스키마의 폐기를 해제했습니다.` })).toBeVisible();
  await expect(head.locator(".app-chip").first()).toHaveText("활성");
  await expect(head.getByRole("button", { name: "폐기", exact: true })).toHaveCount(1);
  await expect(detail.getByText("폐기된 스키마입니다.", { exact: false })).toHaveCount(0);
  // 기본(활성) 목록에 돌아온다.
  await page.goto(`/?screen=schema&schema=${SCHEMA_KEY}`);
  await expect(list.getByRole("heading", { level: 3 })).toHaveText("스키마 목록 (1)");
  await expect(list.getByRole("button", { name: new RegExp(SCHEMA_NAME) }).locator(".app-chip")).toHaveCount(0);
  // 새 프로파일 대화상자에도 다시 나온다.
  await openScreen(page, "파싱 프로파일");
  await page.getByRole("button", { name: "+ 새 프로파일" }).click();
  await expect(page.getByRole("dialog", { name: "새 프로파일" }).getByLabel("파싱 스키마").locator("option")).toHaveText([SCHEMA_NAME]);
  await page.getByRole("dialog", { name: "새 프로파일" }).getByRole("button", { name: "취소" }).click();

  // ---- 같은 상태를 두 번 요청하면 409, 없는 키는 404. 어느 쪽도 상태를 바꾸지 않는다.
  const activeTwice = await api(page, "POST", `/schemas/${SCHEMA_KEY}/activate`);
  expect(activeTwice.status).toBe(409);
  expect(activeTwice.json.error).toMatchObject({ code: "ALREADY_ACTIVE", message: "이미 활성 상태인 스키마입니다." });
  expect((await api(page, "POST", `/schemas/${SCHEMA_KEY}/deprecate`)).status).toBe(200);
  const deprecateTwice = await api(page, "POST", `/schemas/${SCHEMA_KEY}/deprecate`);
  expect(deprecateTwice.status).toBe(409);
  expect(deprecateTwice.json.error).toMatchObject({ code: "ALREADY_DEPRECATED", message: "이미 폐기된 스키마입니다." });
  expect((await api(page, "POST", `/schemas/${SCHEMA_KEY}/activate`)).status).toBe(200);
  expect((await api(page, "GET", `/schemas/${SCHEMA_KEY}`)).json.status).toBe("active");
  const unknown = await api(page, "POST", "/schemas/nope_없는키/deprecate");
  expect(unknown.status).toBe(404);
  expect(unknown.json.error.code).toBe("UNKNOWN_SCHEMA");
  errors.assertClean();
});
