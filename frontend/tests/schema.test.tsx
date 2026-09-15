import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UUID_RE, ids } from "./fixture";
import { SCHEMA_KEY, SECOND_SCHEMA, schemaFixture } from "./schema-fixture";

const route = () => new URLSearchParams(location.search);
const detail = () => screen.getByRole("region", { name: "스키마 상세" });
const fieldPanel = () => screen.getByRole("region", { name: "필드 상세" });
const tree = () => screen.getByRole("tree", { name: "필드 트리" });
const treeItem = (name: string) => within(tree()).getAllByRole("treeitem").find((li) => li.querySelector(".app-tree-name")?.textContent === name)!;

describe("파싱 스키마 화면", () => {
  it("진입은 ≤3 호출(/schemas · /schemas/{key} · /tree)이며 목록·헤더·탭·트리를 보여주고 [트리 보기][그래프 보기] 토글이 URL과 화면을 바꾼다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    expect(f.calls.filter((c) => c.path.startsWith("/schemas")).map((c) => c.path).sort()).toEqual([`/schemas`, `/schemas/${SCHEMA_KEY}`, `/schemas/${SCHEMA_KEY}/tree`]);

    const list = screen.getByRole("region", { name: "스키마 목록" });
    expect(within(list).getByRole("heading", { level: 3 }).textContent).toBe("스키마 목록 (2)");
    const first = within(list).getByRole("button", { name: /공정 데이터 표준/ });
    expect(first.getAttribute("aria-current")).toBe("true");
    expect(first.textContent).toContain("필드 11 · 프로파일 2 · 문서 5");
    expect(within(list).getByRole("button", { name: /레시피 표준/ }).getAttribute("aria-current")).toBeNull();

    const section = detail();
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toContain("공정 데이터 표준 v3");
    expect(within(section).getByText("활성", { selector: ".app-chip" })).toBeTruthy();
    const tabs = within(section).getByRole("tablist", { name: "스키마 상세 탭" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["구조 보기", "사용 프로파일 (2)", "연관 문서 (5)", "변경 이력"]);
    expect(within(tabs).getByRole("tab", { name: "구조 보기" }).getAttribute("aria-selected")).toBe("true");

    const toggle = within(section).getByRole("group", { name: "구조 보기 방식" });
    expect(within(toggle).getByRole("button", { name: "트리 보기" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(toggle).getByRole("button", { name: "그래프 보기" }).getAttribute("aria-pressed")).toBe("false");
    expect(within(tree()).getAllByRole("treeitem").length).toBe(11);
    expect(screen.queryByRole("img", { name: "스키마 그래프" })).toBeNull();
    expect(f.callsTo(/\/graph$/)).toHaveLength(0);

    const user = userEvent.setup();
    await user.click(within(toggle).getByRole("button", { name: "그래프 보기" }));
    expect(route().get("view")).toBe("graph");
    const svg = await screen.findByRole("img", { name: "스키마 그래프" });
    expect(svg.getAttribute("data-nodes")).toBe("10");
    expect(screen.queryByRole("tree", { name: "필드 트리" })).toBeNull();
    expect(within(toggle).getByRole("button", { name: "그래프 보기" }).getAttribute("aria-pressed")).toBe("true");
    expect(f.callsTo(/\/graph$/)).toHaveLength(1);

    await user.click(within(toggle).getByRole("button", { name: "트리 보기" }));
    expect(route().get("view")).toBeNull();
    await screen.findByRole("tree", { name: "필드 트리" });
    expect(screen.queryByRole("img", { name: "스키마 그래프" })).toBeNull();
    // 탭이 바뀌면 토글은 보이지 않는다(구조 보기 안에서만)
    await user.click(within(tabs).getByRole("tab", { name: "변경 이력" }));
    expect(screen.queryByRole("group", { name: "구조 보기 방식" })).toBeNull();
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("트리는 중첩 응답 1회로 전체를 그리고 접기/펼치기·키보드 이동·선택이 되며, 선택하면 ?field_key=와 필드 상세(2회 호출)가 갱신되고 폐기 필드는 흐리다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    expect(f.callsTo(/\/tree$/)).toHaveLength(1);
    expect(fieldPanel().textContent).toContain("트리나 그래프에서 필드를 선택하세요.");
    expect(treeItem("기본 정보").getAttribute("aria-expanded")).toBe("true");
    expect(treeItem("시간(초)").classList.contains("deprecated")).toBe(true);
    expect(within(treeItem("시간(초)")).getByText("폐기", { selector: ".app-chip" })).toBeTruthy();
    expect(treeItem("시간(초)").getAttribute("aria-level")).toBe("3");

    const user = userEvent.setup();
    await user.click(within(treeItem("기본 정보")).getByRole("button", { name: "접기 기본 정보" }));
    expect(treeItem("기본 정보").getAttribute("aria-expanded")).toBe("false");
    expect(within(tree()).queryByText("제품명")).toBeNull();
    expect(within(tree()).getAllByRole("treeitem").length).toBe(9);
    expect(route().get("field_key")).toBeNull();
    await user.click(within(treeItem("기본 정보")).getByRole("button", { name: "펼치기 기본 정보" }));
    expect(within(tree()).getByText("제품명")).toBeTruthy();

    await user.click(treeItem("온도"));
    expect(route().get("field_key")).toBe("temperature");
    expect(treeItem("온도").getAttribute("aria-selected")).toBe("true");
    expect(treeItem("온도").classList.contains("selected")).toBe(true);
    await screen.findByText("공정 설정 온도");
    const panel = fieldPanel();
    expect(panel.textContent).toContain("온도");
    expect(within(panel).getByText("temperature")).toBeTruthy();
    expect(panel.textContent).toContain("float");
    expect(panel.textContent).toContain("°C");
    const aliases = within(panel).getByLabelText("Alias");
    expect(within(aliases).getAllByText(/온도값|Temp/, { selector: ".app-chip" })).toHaveLength(2);
    const relations = within(panel).getByLabelText("필드 관계");
    expect(within(relations).getByRole("button", { name: "공정 정보" })).toBeTruthy();
    expect(within(relations).getByRole("button", { name: "압력" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "2개 보기 ›" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "5개 보기 ›" })).toBeTruthy();
    const fieldCalls = f.calls.filter((c) => c.path.includes("/fields/temperature"));
    expect(fieldCalls).toHaveLength(2);
    expect(fieldCalls.find((c) => c.path.endsWith("/values"))!.url.searchParams.get("limit")).toBe("5");

    // 키보드: 온도에서 아래로 한 칸(압력) → Enter 선택
    treeItem("온도").focus();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(route().get("field_key")).toBe("pressure");
    await within(fieldPanel()).findByText("공정 압력");
    // 부모 링크로 이동
    await user.click(within(within(fieldPanel()).getByLabelText("필드 관계")).getByRole("button", { name: "공정 정보" }));
    expect(route().get("field_key")).toBe("process");
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("그래프 보기는 layoutDomain 배치로 노드 버튼·실선(parent_of)·점선(related_to)을 그리고 확대를 바꾸며 노드 클릭이 필드를 선택한다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&view=graph");
    const svg = await screen.findByRole("img", { name: "스키마 그래프" });
    expect(f.calls.filter((c) => c.path.startsWith("/schemas")).length).toBeLessThanOrEqual(4);
    expect(svg.getAttribute("data-nodes")).toBe("10");
    expect(svg.getAttribute("data-edges")).toBe("9");
    expect(svg.querySelectorAll(".app-graph-edge.parent_of[data-from]")).toHaveLength(7);
    expect(svg.querySelectorAll(".app-graph-edge.related_to")).toHaveLength(2);
    const dashed = svg.querySelector(".app-graph-edge.related_to")!;
    expect(dashed.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(svg.querySelector(".app-graph-edge.parent_of[data-from]")!.getAttribute("stroke-dasharray")).toBeNull();
    // 루트 → 그룹 3개
    expect(svg.querySelectorAll(".app-graph-edge.parent_of:not([data-from])")).toHaveLength(3);
    expect(svg.querySelectorAll(".app-graph-hull")).toHaveLength(3);
    expect(within(svg).getByRole("button", { name: "온도" })).toBeTruthy();
    expect(within(svg).getByRole("button", { name: "온도" }).textContent).toContain("문서 5 · 프로파일 2");
    expect(within(svg).getByRole("button", { name: "공정 정보" }).getAttribute("data-level")).toBe("1");
    expect(svg.textContent).toContain("공정 데이터 표준");

    const user = userEvent.setup();
    const zoom = screen.getByLabelText("그래프 확대") as HTMLSelectElement;
    expect(zoom.value).toBe("100");
    await user.selectOptions(zoom, "50");
    expect(svg.getAttribute("data-zoom")).toBe("50");
    expect(Number(svg.getAttribute("width"))).toBe(600);

    await user.click(within(svg).getByRole("button", { name: "온도" }));
    expect(route().get("field_key")).toBe("temperature");
    expect(within(svg).getByRole("button", { name: "온도" }).getAttribute("aria-pressed")).toBe("true");
    await within(fieldPanel()).findByText("공정 설정 온도");
    // Enter로도 선택
    within(svg).getByRole("button", { name: "압력" }).focus();
    await user.keyboard("{Enter}");
    expect(route().get("field_key")).toBe("pressure");
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("사용 프로파일·연관 문서·변경 이력 탭은 목록을 읽고, 프로파일 행은 프로파일 화면으로, 원본 보기는 Source Review로 이동한다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    const tabs = within(detail()).getByRole("tablist", { name: "스키마 상세 탭" });

    await user.click(within(tabs).getByRole("tab", { name: "사용 프로파일 (2)" }));
    expect(route().get("tab")).toBe("profiles");
    const profiles = await screen.findByRole("table", { name: "사용 프로파일" });
    expect(within(profiles).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["프로파일명", "버전", "규칙", "적용 문서", "상태"]);
    expect(within(profiles).getAllByRole("row")).toHaveLength(3);
    expect(within(profiles).getByText("v2")).toBeTruthy();
    expect(within(profiles).getByText("승인", { selector: ".app-chip" })).toBeTruthy();
    expect(profiles.textContent).toContain("temperature, pressure");
    expect(f.schema.profileFilters).toEqual([null]);

    await user.click(within(tabs).getByRole("tab", { name: "연관 문서 (5)" }));
    expect(route().get("tab")).toBe("documents");
    const docs = await screen.findByRole("table", { name: "연관 문서" });
    expect(within(docs).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "사용 프로파일", "Snapshot", "상태", "원본 보기"]);
    expect(within(docs).getAllByRole("row").length).toBe(6);
    expect(within(docs).getAllByText("공정데이터_A양식 v2").length).toBeGreaterThan(0);
    expect(within(docs).getByText("정상", { selector: ".app-chip" })).toBeTruthy();
    expect(within(docs).getByText("검수 필요", { selector: ".app-chip" })).toBeTruthy();
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}/documents\\?`))[0].url.searchParams.get("limit")).toBe("50");
    expect(docs.textContent).not.toMatch(UUID_RE);

    await user.click(within(tabs).getByRole("tab", { name: "변경 이력" }));
    const history = await screen.findByRole("table", { name: "변경 이력" });
    expect(within(history).getAllByRole("row")).toHaveLength(4);
    expect(within(history).getByText("현재", { selector: ".app-chip" }).closest("td")!.textContent).toContain("v3");
    // 계약 §7: 정의 파일에서 알 수 있는 값만 보여 준다(작성자·요약 열은 없다).
    expect(within(history).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["버전", "일시", "필드"]);
    expect(history.textContent).toContain("필드 14개");
    // '새 리비전'은 헤더에만 있다(탭 안에 같은 버튼을 또 두지 않는다).
    expect(screen.queryByRole("button", { name: "새 리비전 가져오기" })).toBeNull();
    expect(within(detail()).getByRole("button", { name: "새 리비전" })).toBeTruthy();

    // 원본 보기 → Source Review overlay
    await user.click(within(tabs).getByRole("tab", { name: "연관 문서 (5)" }));
    const docs2 = await screen.findByRole("table", { name: "연관 문서" });
    await user.click(within(docs2).getAllByRole("button", { name: "원본 보기" })[0]);
    expect(route().get("review")).toBe(ids.application);
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("사용 프로파일 행 클릭은 ?screen=profiles&profile=로 이동한다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&tab=profiles");
    const profiles = await screen.findByRole("table", { name: "사용 프로파일" });
    const user = userEvent.setup();
    await user.click(within(profiles).getByRole("button", { name: "공정데이터_A양식" }));
    expect(route().get("screen")).toBe("profiles");
    expect(route().get("profile")).toBe(ids.profile);
    expect(route().get("schema")).toBeNull();
    await screen.findByRole("region", { name: "프로파일 상세" });
  });

  it("필드 상세의 'N개 보기 ›'는 탭을 ?field_filter=로 걸어 열고(API ?field_key=) 필터 해제가 된다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&field_key=temperature");
    await screen.findByText("공정 설정 온도");
    const panel = fieldPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "2개 보기 ›" }));
    expect(route().get("tab")).toBe("profiles");
    expect(route().get("field_filter")).toBe("temperature");
    await screen.findByRole("table", { name: "사용 프로파일" });
    expect(f.schema.profileFilters).toEqual(["temperature"]);
    const bar = screen.getByRole("status", { name: "필드 필터" });
    expect(bar.textContent).toContain("온도");

    await user.click(within(panel).getByRole("button", { name: "5개 보기 ›" }));
    expect(route().get("tab")).toBe("documents");
    const docs = await screen.findByRole("table", { name: "연관 문서" });
    await waitFor(() => expect(f.schema.documentFilters).toEqual(["temperature"]));
    expect(within(docs).getAllByRole("row")).toHaveLength(4);

    await user.click(within(screen.getByRole("status", { name: "필드 필터" })).getByRole("button", { name: "필터 해제" }));
    expect(route().get("field_filter")).toBeNull();
    await waitFor(() => expect(f.schema.documentFilters).toEqual(["temperature", null]));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "연관 문서" })).getAllByRole("row")).toHaveLength(6));
    expect(screen.queryByRole("status", { name: "필드 필터" })).toBeNull();
    // 필드 상세는 여전히 열려 있다
    expect(fieldPanel().textContent).toContain("공정 설정 온도");
  });

  it("'Source Review 열기'는 최신 값의 application/rule/sheet/range로 열고, 값이 없으면 비활성 + 힌트다; 최근 값마다 원본 보기", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&field_key=pressure");
    await screen.findByText("공정 압력");
    const panel = fieldPanel();
    const open = (await within(panel).findByRole("button", { name: "Source Review 열기" })) as HTMLButtonElement;
    await waitFor(() => expect(open.disabled).toBe(true));
    expect(open.title).toContain("아직 추출된 값이 없어");
    expect(within(panel).getByRole("note").textContent).toContain("아직 추출된 값이 없습니다");
    expect(within(panel).queryByRole("list", { name: "최근 값" })).toBeNull();

    const user = userEvent.setup();
    await user.click(treeItem("온도"));
    const panel2 = fieldPanel();
    await within(panel2).findByText("공정 설정 온도");
    const open2 = (await within(panel2).findByRole("button", { name: "Source Review 열기" })) as HTMLButtonElement;
    await waitFor(() => expect(open2.disabled).toBe(false));
    const recent = within(panel2).getByRole("list", { name: "최근 값" });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(5);
    expect(recent.textContent).toContain("Sheet1!C3");
    expect(within(recent).getAllByRole("button", { name: "원본 보기" })).toHaveLength(5);
    expect(panel2.textContent).not.toMatch(UUID_RE);

    await user.click(open2);
    expect(route().get("review")).toBe(ids.application);
    expect(route().get("rule")).toBe("temperature");
    expect(route().get("sheet")).toBe(ids.sheet1);
    expect(route().get("range")).toBe("C3");
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("필드 편집은 바뀐 항목만 PATCH /schemas/{key}/fields/{field_key}로 보내고 화면·트리를 갱신하며 실패는 알린다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&field_key=temperature");
    await screen.findByText("공정 설정 온도");
    const panel = fieldPanel();
    const user = userEvent.setup();
    await user.click(within(panel).getByRole("button", { name: "편집" }));
    const form = within(panel).getByRole("form", { name: "필드 편집" });
    const save = within(form).getByRole("button", { name: "저장" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect((within(form).getByLabelText("Alias") as HTMLInputElement).value).toBe("온도값, Temp");
    await user.clear(within(form).getByLabelText("설명"));
    await user.type(within(form).getByLabelText("설명"), "공정 설정 온도(°C)");
    await user.type(within(form).getByLabelText("Alias"), ", 온도측정");
    expect(save.disabled).toBe(false);
    await user.click(save);
    await waitFor(() => expect(f.schema.patched).toHaveLength(1));
    expect(f.schema.patched[0]).toEqual({ key: "temperature", description: "공정 설정 온도(°C)", aliases: ["온도값", "Temp", "온도측정"] });
    const patch = f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}/fields/temperature$`), "PATCH");
    expect(patch).toHaveLength(1);
    expect(patch[0].body).toEqual({ description: "공정 설정 온도(°C)", aliases: ["온도값", "Temp", "온도측정"] });
    await within(fieldPanel()).findByText("공정 설정 온도(°C)");
    expect(within(within(fieldPanel()).getByLabelText("Alias")).getByText("온도측정")).toBeTruthy();
    expect(within(fieldPanel()).queryByRole("form", { name: "필드 편집" })).toBeNull();
    await waitFor(() => expect(f.callsTo(/\/tree$/)).toHaveLength(2));

    // 폐기 → 트리에서 흐리게
    await user.click(within(fieldPanel()).getByRole("button", { name: "편집" }));
    await user.selectOptions(within(fieldPanel()).getByLabelText("상태"), "deprecated");
    await user.click(within(fieldPanel()).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(f.schema.patched).toHaveLength(2));
    expect(f.schema.patched[1]).toEqual({ key: "temperature", status: "deprecated" });
    await waitFor(() => expect(treeItem("온도").classList.contains("deprecated")).toBe(true));
    expect(within(fieldPanel()).getByText("폐기", { selector: ".app-chip" })).toBeTruthy();

    // 실패(422)는 폼을 유지하고 오류를 보여준다
    f.overrides.set(`PATCH /schemas/${SCHEMA_KEY}/fields/temperature`, () => ({ __status: 422, body: { error: { code: "FIELD_LOCKED", message: "발행된 값이 있는 필드는 이름을 바꿀 수 없습니다." } } }));
    await user.click(within(fieldPanel()).getByRole("button", { name: "편집" }));
    await user.type(within(fieldPanel()).getByLabelText("필드명"), "2");
    await user.click(within(fieldPanel()).getByRole("button", { name: "저장" }));
    expect((await within(fieldPanel()).findByRole("alert")).textContent).toContain("발행된 값이 있는 필드는 이름을 바꿀 수 없습니다.");
    expect(within(fieldPanel()).getByRole("form", { name: "필드 편집" })).toBeTruthy();
    await user.click(within(fieldPanel()).getByRole("button", { name: "취소" }));
    expect(within(fieldPanel()).queryByRole("form", { name: "필드 편집" })).toBeNull();
    expect(fieldPanel().textContent).toContain("온도");
  });

  it("'새 스키마'는 정의 JSON을 POST /schemas {definition}로 보내고 새 스키마를 선택한다; 검색은 250ms 뒤 목록을 거른다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "새 스키마" }));
    const dialog = await screen.findByRole("dialog", { name: "새 스키마" });
    const submit = within(dialog).getByRole("button", { name: "가져오기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const editor = within(dialog).getByLabelText("정의 JSON");
    await user.type(editor, "{{oops");
    expect(within(dialog).getByRole("alert").textContent).toContain("JSON을 해석할 수 없습니다.");
    await user.clear(editor);
    await user.paste(JSON.stringify({ schema_key: "quality_std", schema_name: "품질 보고서 표준", fields: [{ key: "lot", name: "LOT" }] }));
    expect(within(dialog).getByLabelText("정의 요약").textContent).toContain("품질 보고서 표준 (quality_std) · 필드 1");
    expect(submit.disabled).toBe(false);
    await user.click(submit);
    await waitFor(() => expect(f.schema.imported).toHaveLength(1));
    expect(f.schema.imported[0]).toEqual({ definition: { schema_key: "quality_std", schema_name: "품질 보고서 표준", fields: [{ key: "lot", name: "LOT" }] } });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 스키마" })).toBeNull());
    expect(route().get("schema")).toBe("quality_std");
    await waitFor(() => expect(within(detail()).getByRole("heading", { level: 2 }).textContent).toContain("품질 보고서 표준 v1"));
    expect(within(screen.getByRole("region", { name: "스키마 목록" })).getByRole("button", { name: /품질 보고서 표준/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("status").textContent || screen.getAllByRole("status").map((s) => s.textContent).join()).toContain("품질 보고서 표준 v1 저장됨");

    await user.type(screen.getByLabelText("스키마 검색"), "레시피");
    await waitFor(() => expect(within(screen.getByRole("region", { name: "스키마 목록" })).getAllByRole("button", { name: /표준/ })).toHaveLength(1));
    expect(screen.getByRole("button", { name: /레시피 표준/ })).toBeTruthy();
    // 검색은 클라이언트 필터 — /schemas 재호출 없음
    expect(f.callsTo(/^\/schemas$/).length).toBeLessThanOrEqual(2);
  });

  it("헤더의 '새 리비전'은 PUT /schemas/{key} {definition}을 보낸다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&tab=history");
    await screen.findByRole("table", { name: "변경 이력" });
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole("button", { name: "새 리비전" }));
    const dialog = await screen.findByRole("dialog", { name: /새 리비전/ });
    // 현재 정의를 채워 둔다(GET /schemas/{key}/revisions/{rev}).
    const editor = within(dialog).getByLabelText("정의 JSON") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain(`"schema_key": "${SCHEMA_KEY}"`));
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}/revisions/3$`))).toHaveLength(1);
    await user.clear(editor);
    await user.paste(JSON.stringify({ schema_key: SCHEMA_KEY, schema_name: "공정 데이터 표준", fields: [] }));
    await user.click(within(dialog).getByRole("button", { name: "새 리비전 저장" }));
    await waitFor(() => expect(f.schema.revised).toHaveLength(1));
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}$`), "PUT")[0].body).toEqual({ definition: { schema_key: SCHEMA_KEY, schema_name: "공정 데이터 표준", fields: [] } });
    await waitFor(() => expect(within(detail()).getByRole("heading", { level: 2 }).textContent).toContain("공정 데이터 표준 v4"));
  });
  it("'새 스키마'는 생성 전용이라 이미 있는 키면 409 SCHEMA_EXISTS 메시지를 그대로 보여 주고 아무것도 바꾸지 않는다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "새 스키마" }));
    const dialog = await screen.findByRole("dialog", { name: "새 스키마" });
    await user.click(within(dialog).getByLabelText("정의 JSON"));
    await user.paste(JSON.stringify({ schema_key: SCHEMA_KEY, schema_name: "공정 데이터 표준", fields: [] }));
    await user.click(within(dialog).getByRole("button", { name: "가져오기" }));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog", { name: "새 스키마" })).getByRole("alert").textContent).toContain(
        "이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요.",
      ),
    );
    // 아무것도 쓰이지 않았다(리비전도 늘지 않는다).
    expect(f.schema.imported).toHaveLength(0);
    expect(f.schema.revised).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "새 스키마" })).toBeTruthy();
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}$`), "PUT")).toHaveLength(0);
  });

  it("쓰는 프로파일·적용 문서가 없는 스키마만 '삭제'가 뜨고, 지우면 목록에서 빠진다", async () => {
    const f = schemaFixture();
    f.renderApp(`?screen=schema&schema=${SECOND_SCHEMA.schema_key}`);
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "스키마 삭제" });
    expect(dialog.textContent).toContain("'레시피 표준'과(와) 필드 3개를 지웁니다. 되돌릴 수 없습니다.");
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(f.schema.deletedSchemas).toEqual([SECOND_SCHEMA.schema_key]));
    expect(f.callsTo(new RegExp(`^/schemas/${SECOND_SCHEMA.schema_key}$`), "DELETE")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스키마 삭제" })).toBeNull());
    expect(await screen.findByText("'레시피 표준' 스키마를 지웠습니다.")).toBeTruthy();
    const list = screen.getByRole("region", { name: "스키마 목록" });
    await waitFor(() => expect(within(list).queryByRole("button", { name: /레시피 표준/ })).toBeNull());
    expect(route().get("schema")).toBe(SCHEMA_KEY);
  });

  it("쓰는 프로파일·적용 문서가 있는 스키마에는 '삭제' 버튼이 아예 없다(언제나 실패하는 버튼을 두지 않는다)", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    expect(within(detail()).queryByRole("button", { name: "삭제" })).toBeNull();
    // 왜 지울 수 없는지는 헤더의 사용 현황이 말한다.
    expect(detail().textContent).toContain("프로파일 2 · 문서 5");
    expect(f.schema.deletedSchemas).toHaveLength(0);
  });

  it("같은 키로 다시 만든 스키마는 목록에 바로 다시 나타난다(삭제 기억이 남지 않는다)", async () => {
    const f = schemaFixture();
    f.renderApp(`?screen=schema&schema=${SECOND_SCHEMA.schema_key}`);
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "스키마 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    const list = screen.getByRole("region", { name: "스키마 목록" });
    await waitFor(() => expect(within(list).queryByRole("button", { name: /레시피 표준/ })).toBeNull());
    // 같은 키로 다시 만든다 → 목록에도 다시 보이고 그 상세가 열린다.
    await user.click(screen.getAllByRole("button", { name: "새 스키마" })[0]);
    const create = await screen.findByRole("dialog", { name: "새 스키마" });
    const editor = within(create).getByLabelText("정의 JSON") as HTMLTextAreaElement;
    await user.clear(editor);
    await user.paste(JSON.stringify({ schema_key: SECOND_SCHEMA.schema_key, schema_name: SECOND_SCHEMA.schema_name, fields: [] }));
    await user.click(within(create).getByRole("button", { name: "가져오기" }));
    await waitFor(() => expect(within(list).getByRole("button", { name: /레시피 표준/ })).toBeTruthy());
    expect(route().get("schema")).toBe(SECOND_SCHEMA.schema_key);
  });

  it("'이름 바꾸기'는 현재 정의의 schema_name만 바꿔 PUT하고, '+ 필드 추가'는 POST .../fields 뒤 새 필드를 선택한다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema");
    await screen.findByRole("tree", { name: "필드 트리" });
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole("button", { name: "이름 바꾸기" }));
    const rename = await screen.findByRole("dialog", { name: "스키마 이름 바꾸기" });
    const save = within(rename).getByRole("button", { name: "저장" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    const input = within(rename).getByLabelText("스키마명") as HTMLInputElement;
    expect(input.value).toBe("공정 데이터 표준");
    await user.clear(input);
    expect(save.disabled).toBe(true);
    await user.type(input, "공정 표준(개정)");
    await user.click(save);
    await waitFor(() => expect(f.schema.revised).toHaveLength(1));
    expect(f.schema.revised[0].definition.schema_name).toBe("공정 표준(개정)");
    expect(f.schema.revised[0].definition.schema_key).toBe(SCHEMA_KEY);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스키마 이름 바꾸기" })).toBeNull());

    await user.click(screen.getByRole("button", { name: "+ 필드 추가" }));
    const add = await screen.findByRole("dialog", { name: "필드 추가" });
    const submit = within(add).getByRole("button", { name: "추가" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.type(within(add).getByLabelText("영문 키"), "lot_no");
    await user.type(within(add).getByLabelText("필드명"), "LOT 번호");
    await user.selectOptions(within(add).getByLabelText("상위 필드"), "process");
    await user.click(submit);
    await waitFor(() => expect(f.schema.created).toHaveLength(1));
    // 타입 기본값은 계약 §1.2의 value_type 어휘를 따른다(text·decimal·boolean·date·datetime·group) — "string"은 없는 값이다.
    expect(f.schema.created[0]).toEqual({ field_key: "lot_no", name: "LOT 번호", type: "text", parent_field_key: "process" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "필드 추가" })).toBeNull());
    expect(route().get("field_key")).toBe("lot_no");
    expect(await screen.findByText("LOT 번호 필드 저장됨")).toBeTruthy();
  });

  it("필드 '삭제'는 그 필드를 뺀 새 리비전을 저장하고 v{rev} 토스트를 띄운다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&field_key=temperature");
    await screen.findByText("공정 설정 온도", undefined, { timeout: 4000 });
    const user = userEvent.setup();
    await user.click(within(fieldPanel()).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "필드 삭제" });
    expect(dialog.textContent).toContain("'온도' 필드를 지운 새 리비전을 저장합니다.");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(f.schema.deletedFields).toEqual(["temperature"]));
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}/fields/temperature$`), "DELETE")).toHaveLength(1);
    expect(await screen.findByText("'온도' 필드를 지웠습니다 · v4")).toBeTruthy();
    await waitFor(() => expect(route().get("field_key")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "필드 삭제" })).toBeNull());
  });

  it("자식이 있는 필드 삭제는 409 FIELD_HAS_CHILDREN으로 막고 '하위 필드 보기'가 그 필드로 보낸다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&field_key=duration");
    // 목록 → 상세 → 트리 → 필드 상세 순서로 읽는다.
    await screen.findByRole("tree", { name: "필드 트리" }, { timeout: 4000 });
    const user = userEvent.setup();
    await user.click(await within(fieldPanel()).findByRole("button", { name: "삭제" }, { timeout: 4000 }));
    const dialog = await screen.findByRole("dialog", { name: "필드 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("하위 필드 1개가 있습니다. 먼저 하위 필드를 지우세요.");
    // 근거(detail.children)는 버튼을 누르지 않아도 모달 안에 보인다
    expect(within(within(dialog).getByRole("list", { name: "하위 필드" })).getByText("시간(초)")).toBeTruthy();
    expect(f.schema.deletedFields).toHaveLength(0);
    expect((within(dialog).getByRole("button", { name: "삭제" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(alert).getByRole("button", { name: "하위 필드 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "필드 삭제" })).toBeNull());
    expect(route().get("field_key")).toBe("duration_sec");
  });

  it("쓰이는 필드 삭제는 409 FIELD_IN_USE로 막고 어느 프로파일·규칙이 쓰는지 보여 준다", async () => {
    const f = schemaFixture();
    f.schema.fieldInUse.add("pressure");
    f.renderApp("?screen=schema&field_key=pressure");
    await screen.findByText("공정 압력", undefined, { timeout: 4000 });
    const user = userEvent.setup();
    await user.click(within(fieldPanel()).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "필드 삭제" });
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("공정데이터_A양식 외 1개 프로파일이 이 필드를 씁니다. 추출값 5건이 남아 있습니다.");
    expect(within(dialog).getByRole("list", { name: "사용 프로파일" }).textContent).toContain("규칙 pressure");
    expect(f.schema.deletedFields).toHaveLength(0);
    await user.click(within(alert).getByRole("button", { name: "사용 프로파일 보기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "필드 삭제" })).toBeNull());
    expect(route().get("tab")).toBe("profiles");
    expect(route().get("field_filter")).toBe("pressure");
  });
});

// §4.2.3 스키마 폐기·폐기 해제 — 낱말은 프로파일과 같은 '폐기'다('비활성화'라고 부르지 않는다).
describe("스키마 폐기(§4.2.3)", () => {
  // 상태 칩은 헤더의 것을 본다(트리에도 폐기된 필드 칩이 있다).
  const statusChip = (label: string) => within(detail().querySelector(".app-card-head") as HTMLElement).getByText(label, { selector: ".app-chip" });
  it("목록은 기본으로 활성만 읽고, 폐기하면 응답 하나로 상세를 갱신한 뒤 목록에서 빠진다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&schema=" + SCHEMA_KEY);
    await screen.findByRole("tree", { name: "필드 트리" });
    // 기본은 활성 — status 파라미터를 붙이지 않는다(서버 기본값과 같다).
    expect(f.callsTo(/^\/schemas(\?|$)/)).toHaveLength(1);
    expect(f.callsTo(/^\/schemas(\?|$)/)[0].url.searchParams.get("status")).toBeNull();
    const section = detail();
    expect(within(section).queryByRole("button", { name: "폐기 해제" })).toBeNull();

    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "폐기" }));
    const dialog = await screen.findByRole("dialog", { name: "스키마 폐기" });
    expect(dialog.textContent).toContain(
      "'공정 데이터 표준'을(를) 폐기합니다. 새 파싱 프로파일을 이 스키마에 만들 수 없게 되고 목록 기본에서 숨깁니다. 이미 있는 프로파일·적용 건·추출값은 그대로이며 언제든 '폐기 해제'할 수 있습니다.",
    );
    await user.click(within(dialog.querySelector(".app-modal-actions") as HTMLElement).getByRole("button", { name: "폐기" }));
    await f.waitForApi(new RegExp(`^/schemas/${SCHEMA_KEY}/deprecate$`), "POST");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "스키마 폐기" })).toBeNull());

    // 응답만으로 상태 칩·버튼·안내가 바뀐다.
    await waitFor(() => expect(statusChip("폐기")).toBeTruthy());
    expect(within(detail()).getByRole("button", { name: "폐기 해제" })).toBeTruthy();
    expect(within(detail()).queryByRole("button", { name: "폐기" })).toBeNull();
    expect(detail().textContent).toContain("폐기된 스키마입니다. 이미 승인된 파싱 프로파일은 새 문서에 계속 적용됩니다 — 멈추려면 프로파일을 폐기하세요.");
    expect(await screen.findByText(/'공정 데이터 표준' 스키마를 폐기했습니다\./)).toBeTruthy();
    // 목록만 다시 읽고(기본=활성) 그 스키마는 빠진다. 상세·트리는 다시 읽지 않는다.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "스키마 목록" })).queryByRole("button", { name: /공정 데이터 표준/ })).toBeNull());
    expect(f.callsTo(new RegExp(`^/schemas/${SCHEMA_KEY}/tree$`))).toHaveLength(1);
  });

  it("상태 필터 `폐기`로 다시 보이고, `폐기 해제`는 확인 없이 바로 되돌린다", async () => {
    const f = schemaFixture();
    f.schema.schemas = f.schema.schemas.map((s) => (s.schema_key === SCHEMA_KEY ? { ...s, status: "deprecated" } : s));
    f.renderApp("?screen=schema&schema=" + SCHEMA_KEY);
    await screen.findByRole("tree", { name: "필드 트리" });
    const list = screen.getByRole("region", { name: "스키마 목록" });
    expect(within(list).queryByRole("button", { name: /공정 데이터 표준/ })).toBeNull();

    const user = userEvent.setup();
    await user.selectOptions(within(list).getByLabelText("상태"), "deprecated");
    expect(route().get("schema_status")).toBe("deprecated");
    await f.waitForApi(/^\/schemas\?.*status=deprecated/);
    const row = await within(list).findByRole("button", { name: /공정 데이터 표준/ });
    expect(within(row).getByText("폐기", { selector: ".app-chip" })).toBeTruthy();

    // 되돌릴 수 있는 일이므로 확인 대화상자 없이 바로 부른다.
    await user.click(within(detail()).getByRole("button", { name: "폐기 해제" }));
    await f.waitForApi(new RegExp(`^/schemas/${SCHEMA_KEY}/activate$`), "POST");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.schema.statusWrites).toEqual([{ schema_key: SCHEMA_KEY, action: "activate" }]);
    await waitFor(() => expect(statusChip("활성")).toBeTruthy());
    expect(await screen.findByText(/'공정 데이터 표준' 스키마의 폐기를 해제했습니다\./)).toBeTruthy();
    // 상태 필터가 `폐기`인 목록에서는 이제 빠진다.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "스키마 목록" })).queryByRole("button", { name: /공정 데이터 표준/ })).toBeNull());
  });

  it("폐기 실패(409 ALREADY_DEPRECATED)는 대화상자를 열어 둔 채 서버 문구를 보인다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&schema=" + SCHEMA_KEY);
    await screen.findByRole("tree", { name: "필드 트리" });
    f.overrides.set(`POST /schemas/${SCHEMA_KEY}/deprecate`, () => ({ __status: 409, body: { error: { code: "ALREADY_DEPRECATED", message: "이미 폐기된 스키마입니다." } } }));
    const user = userEvent.setup();
    await user.click(within(detail()).getByRole("button", { name: "폐기" }));
    const dialog = await screen.findByRole("dialog", { name: "스키마 폐기" });
    await user.click(within(dialog.querySelector(".app-modal-actions") as HTMLElement).getByRole("button", { name: "폐기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("이미 폐기된 스키마입니다.");
    expect(statusChip("활성")).toBeTruthy();
  });

  it("스키마를 모두 폐기하면 '스키마가 없다'가 아니라 돌아갈 길을 안내한다", async () => {
    const f = schemaFixture();
    f.schema.schemas = f.schema.schemas.map((s) => ({ ...s, status: "deprecated" as const }));
    f.renderApp("?screen=schema");
    const list = await screen.findByRole("region", { name: "스키마 목록" });
    await f.waitForApi(/^\/schemas\?.*status=deprecated/);
    expect(
      await within(list).findByText("활성 파싱 스키마가 없습니다. 폐기한 스키마는 상태를 '폐기'로 바꿔 보고 '폐기 해제'할 수 있습니다."),
    ).toBeTruthy();
    // 같은 스키마를 다시 만들게 두지 않는다 — 폐기 목록으로 가는 버튼을 준다.
    expect(within(list).queryByRole("button", { name: "새 스키마" })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(list).getByRole("button", { name: "폐기된 스키마 보기" }));
    expect(await within(list).findByText("공정 데이터 표준")).toBeTruthy();
    expect((within(list).getByLabelText("상태") as HTMLSelectElement).value).toBe("deprecated");
  });

  it("스키마가 하나도 없으면 지금까지처럼 `새 스키마`를 권한다", async () => {
    const f = schemaFixture();
    f.schema.schemas = [];
    f.renderApp("?screen=schema");
    const list = await screen.findByRole("region", { name: "스키마 목록" });
    expect(await within(list).findByText("아직 파싱 스키마가 없습니다. 정의 JSON을 가져와 시작하세요.")).toBeTruthy();
    expect(within(list).getByRole("button", { name: "새 스키마" })).toBeTruthy();
  });

  it("상태 필터 `전체`는 활성·폐기를 함께 보이고 빈 결과는 조건 문구로 안내한다", async () => {
    const f = schemaFixture();
    f.renderApp("?screen=schema&schema_status=all");
    const list = await screen.findByRole("region", { name: "스키마 목록" });
    await f.waitForApi(/^\/schemas\?.*status=all/);
    await waitFor(() => expect(within(list).getByRole("heading", { level: 3 }).textContent).toBe("스키마 목록 (2)"));
    const user = userEvent.setup();
    await user.selectOptions(within(list).getByLabelText("상태"), "deprecated");
    await f.waitForApi(/^\/schemas\?.*status=deprecated/);
    expect(await within(list).findByText("조건에 맞는 파싱 스키마가 없습니다.")).toBeTruthy();
    // 빈 목록이어도 '새 스키마'를 권하지 않는다(필터 때문이지 스키마가 없어서가 아니다).
    expect(within(list).queryByRole("button", { name: "새 스키마" })).toBeNull();
  });
});
