import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBuildDraft } from "../src/app/buildDraft";
import { BUILD_COLUMNS_KEY } from "../src/app/buildModel";
import { UUID_RE, SHA_RE } from "./fixture";
import { BUILD_KEY, SCHEMA_KEY, buildFixture } from "./build-fixture";

const route = () => new URLSearchParams(location.search);
const stepButtons = () => within(screen.getByRole("navigation", { name: "빌드 단계" })).getAllByRole("button");
const currentStep = () => stepButtons().find((b) => b.getAttribute("aria-current") === "step")?.textContent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("데이터 빌드 화면", () => {
  it("초안이 비어 있으면 빈 상태와 '문서 화면에서 선택' 행동을 보여주고 후보를 조회하지 않는다", async () => {
    const f = buildFixture({ documents: [] });
    f.renderApp("?screen=build");
    await screen.findByRole("heading", { name: "데이터 빌드" });
    expect(stepButtons().map((b) => b.textContent)).toEqual(["대상 문서", "스키마", "출력 설정", "미리보기", "생성"]);
    expect(currentStep()).toBe("대상 문서");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "문서 화면에서 선택" }));
    expect(route().get("screen")).toBe("documents");
    expect(f.callsTo(/^\/builds\/candidates/, "POST")).toHaveLength(0);
  });

  it("1단계: 후보 요약·제외 사유·프로파일을 보여주고, 제거는 초안을 갱신해 후보를 다시 조회한다", async () => {
    const f = buildFixture();
    const { container } = f.renderApp("?screen=build");
    await screen.findByText(/입력 문서 3개 · 사용 가능 1개 · 제외 2개/);
    expect(f.callsTo(/^\/builds\/candidates/, "POST")).toHaveLength(1);
    expect(f.callsTo(/^\/builds\/candidates/, "POST")[0].body).toEqual({ document_ids: [f.ids.document(1), f.ids.document(2), f.ids.document(4)] });
    const table = screen.getByRole("table", { name: "대상 문서" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "사용 가능", "제외 사유", "프로파일", "제거"]);
    expect(within(table).getAllByText("사용 가능", { selector: ".app-chip" })).toHaveLength(1);
    expect(within(table).getAllByText("제외", { selector: ".app-chip" })).toHaveLength(2);
    expect(within(table).getByText("검수 필요")).toBeTruthy();
    expect(within(table).getByText("프로파일 없음")).toBeTruthy();
    expect(within(table).getAllByText("공정데이터_A양식 v2")).toHaveLength(2);
    // ID 비노출(§7)
    expect(container.textContent).not.toMatch(UUID_RE);
    expect(container.textContent).not.toMatch(SHA_RE);
    // 스텝퍼: 스키마까지만 도달 가능
    const steps = stepButtons();
    expect(steps[1].hasAttribute("disabled")).toBe(false);
    expect(steps[2].hasAttribute("disabled")).toBe(true);

    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "구양식_2019_07.xlsx 제거" }));
    expect(getBuildDraft().document_ids).toEqual([f.ids.document(1), f.ids.document(2)]);
    await f.waitForApi(/^\/builds\/candidates/, "POST", 2);
    expect(f.callsTo(/^\/builds\/candidates/, "POST")[1].body).toEqual({ document_ids: [f.ids.document(1), f.ids.document(2)] });
    await screen.findByText(/입력 문서 2개 · 사용 가능 1개 · 제외 1개/);
    expect(within(screen.getByRole("table", { name: "대상 문서" })).queryByText("구양식_2019_07.xlsx")).toBeNull();
    // 문서 다시 선택은 초안을 유지한 채 문서 화면으로 간다
    await user.click(screen.getByRole("button", { name: "문서 다시 선택" }));
    expect(route().get("screen")).toBe("documents");
    expect(getBuildDraft().document_ids).toHaveLength(2);
  });

  it("2단계: 스키마를 고르면 schema_key로 후보를 다시 조회하고, 3단계 헤더는 빈 값·중복이면 오류와 함께 다음이 비활성화된다", async () => {
    const f = buildFixture();
    f.renderApp("?screen=build");
    await screen.findByText(/입력 문서 3개/);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "다음: 스키마" }));
    expect(route().get("step")).toBe("2");
    expect(currentStep()).toBe("스키마");
    await f.waitForApi(/^\/schemas$/);
    await screen.findByRole("option", { name: /공정 데이터 표준 v3/ });
    await user.selectOptions(screen.getByLabelText("파싱 스키마"), SCHEMA_KEY);
    expect(getBuildDraft().schema_key).toBe(SCHEMA_KEY);
    await f.waitForApi(/^\/builds\/candidates/, "POST", 2);
    expect(f.callsTo(/^\/builds\/candidates/, "POST")[1].body).toEqual({
      document_ids: [f.ids.document(1), f.ids.document(2), f.ids.document(4)],
      schema_key: SCHEMA_KEY,
    });
    await screen.findByText("제품명 · 3");
    await user.click(screen.getByRole("button", { name: "다음: 출력 설정" }));
    expect(route().get("step")).toBe("3");

    const table = await screen.findByRole("table", { name: "출력 컬럼 설정" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["사용", "원본 Field", "출력 Header", "Type", "Unit", "값 있는 문서", "순서"]);
    const product = screen.getByLabelText("제품명 출력 Header") as HTMLInputElement;
    const temperature = screen.getByLabelText("온도 출력 Header") as HTMLInputElement;
    expect(product.value).toBe("제품명");
    expect(temperature.value).toBe("온도");
    expect(within(table).getAllByText("3/1")).toHaveLength(2);
    const next = () => screen.getByRole("button", { name: "다음: 미리보기" });
    expect(next().hasAttribute("disabled")).toBe(false);

    // 빈 값
    await user.clear(temperature);
    expect(temperature.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("출력 Header를 입력하세요.")).toBeTruthy();
    expect(next().hasAttribute("disabled")).toBe(true);
    expect(stepButtons()[3].hasAttribute("disabled")).toBe(true);
    // 중복
    await user.type(temperature, "제품명");
    expect(screen.getAllByText("중복된 출력 Header입니다.")).toHaveLength(2);
    expect(product.getAttribute("aria-invalid")).toBe("true");
    expect(next().hasAttribute("disabled")).toBe(true);
    // 고치면 활성화
    await user.clear(temperature);
    await user.type(temperature, "온도_C");
    expect(screen.queryByText("중복된 출력 Header입니다.")).toBeNull();
    expect(next().hasAttribute("disabled")).toBe(false);
    // 사용 해제한 컬럼은 검사하지 않는다
    await user.click(screen.getByRole("checkbox", { name: "제품명 사용" }));
    expect(product.disabled).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "온도 사용" }));
    expect(screen.getByText("출력할 컬럼을 하나 이상 선택하세요.")).toBeTruthy();
    expect(next().hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "온도 사용" }));
    expect(next().hasAttribute("disabled")).toBe(false);
    // 설정은 세션 저장소에 남는다
    const saved = JSON.parse(sessionStorage.getItem(BUILD_COLUMNS_KEY)!);
    expect(saved.schema_key).toBe(SCHEMA_KEY);
    expect(saved.columns).toEqual([
      { field_key: "product_name", header: "제품명", enabled: false },
      { field_key: "temperature", header: "온도_C", enabled: true },
    ]);
  });

  it("3단계 순서 변경(버튼·드래그)과 행 구성은 미리보기 요청의 컬럼 순서에 반영된다", async () => {
    const f = buildFixture({ schemaKey: SCHEMA_KEY });
    f.renderApp("?screen=build&step=3");
    await screen.findByRole("table", { name: "출력 컬럼 설정" });
    expect(f.callsTo(/^\/builds\/candidates/, "POST")).toHaveLength(1);
    const order = () => Array.from(document.querySelectorAll<HTMLElement>(".app-build-columns tbody tr")).map((tr) => tr.dataset.field);
    await waitFor(() => expect(order()).toEqual(["product_name", "temperature"]));
    const user = userEvent.setup();
    expect(screen.getByRole("button", { name: "제품명 위로" }).hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByRole("button", { name: "제품명 아래로" }));
    expect(order()).toEqual(["temperature", "product_name"]);
    // 드래그: 제품명을 첫 행으로
    const rows = document.querySelectorAll<HTMLElement>(".app-build-columns tbody tr");
    fireEvent.dragStart(rows[1]);
    fireEvent.dragOver(rows[0]);
    fireEvent.drop(rows[0]);
    expect(order()).toEqual(["product_name", "temperature"]);
    await user.click(screen.getByRole("button", { name: "온도 위로" }));
    expect(order()).toEqual(["temperature", "product_name"]);
    await user.selectOptions(screen.getByLabelText("행 구성"), "document");

    await user.click(screen.getByRole("button", { name: "다음: 미리보기" }));
    expect(route().get("step")).toBe("4");
    await f.waitForApi(/^\/builds\/preview/, "POST");
    const previews = f.callsTo(/^\/builds\/preview/, "POST");
    expect(previews).toHaveLength(1);
    expect(previews[0].body).toEqual({
      document_ids: [f.ids.document(1), f.ids.document(2), f.ids.document(4)],
      schema_key: SCHEMA_KEY,
      columns: [
        { field_key: "temperature", header: "온도" },
        { field_key: "product_name", header: "제품명" },
      ],
      row_mode: "document",
    });
    const table = await screen.findByRole("table", { name: "미리보기" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["#", "온도", "제품명"]);
  });

  it("4단계 미리보기 셀의 원본 보기는 review·rule·sheet·range를 URL에 실어 Source Review를 연다", async () => {
    const f = buildFixture({ schemaKey: SCHEMA_KEY });
    const { container } = f.renderApp("?screen=build&step=4");
    const table = await screen.findByRole("table", { name: "미리보기" });
    expect(screen.getByText(/총 120행 · 표시 3행/)).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("102.1")).toBeTruthy();
    // 제외 문서·충돌
    expect(within(screen.getByLabelText("제외 문서")).getByText("공정데이터_2024_02.xlsx")).toBeTruthy();
    expect(within(screen.getByLabelText("제외 문서")).getByText("검수 필요")).toBeTruthy();
    expect(within(screen.getByLabelText("충돌")).getByText(/101\.2 \/ 101\.5/)).toBeTruthy();
    expect(container.textContent).not.toMatch(UUID_RE);

    const user = userEvent.setup();
    const link = within(table).getByRole("button", { name: "온도 1행 원본 보기" });
    expect(link.getAttribute("title")).toBe("Sheet1!C3");
    await user.click(link);
    expect(route().get("review")).toBe(f.ids.application);
    expect(route().get("rule")).toBe("temperature");
    expect(route().get("sheet")).toBe(f.ids.sheet1);
    expect(route().get("range")).toBe("C3");
    expect(route().get("step")).toBe("4");
    await screen.findByRole("dialog", { name: "Source Review" });
    expect(container.querySelector(".app-main")?.hasAttribute("inert")).toBe(true);
  });

  it("5단계: 형식을 고르고 생성하면 POST /builds?wait=30이 호출되고 다운로드·manifest 요약·새 빌드를 제공한다", async () => {
    const f = buildFixture({ schemaKey: SCHEMA_KEY });
    const { container } = f.renderApp("?screen=build&step=5");
    await screen.findByRole("radiogroup", { name: "출력 형식" });
    expect(currentStep()).toBe("생성");
    const radios = screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value);
    expect(radios).toEqual(["csv", "xlsx", "sqlite"]);
    expect((screen.getByRole("radio", { name: "XLSX" }) as HTMLInputElement).checked).toBe(true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: "파일 생성" }));
    await f.waitForApi(/^\/builds\?/, "POST");
    const call = f.callsTo(/^\/builds\?/, "POST")[0];
    expect(call.url.searchParams.get("wait")).toBe("30");
    expect(call.body).toEqual({
      document_ids: [f.ids.document(1), f.ids.document(2), f.ids.document(4)],
      schema_key: SCHEMA_KEY,
      columns: [
        { field_key: "product_name", header: "제품명" },
        { field_key: "temperature", header: "온도" },
      ],
      row_mode: "record",
      format: "csv",
    });
    const card = await screen.findByLabelText("빌드 결과");
    expect(within(card).getByText("data.csv")).toBeTruthy();
    expect(within(card).getByText(/행 120개 · 컬럼 2개 · 원본 문서 1개/)).toBeTruthy();

    // 다운로드: download_url로 링크 클릭
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });
    await user.click(within(card).getByRole("button", { name: "다운로드" }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    // 먼저 상태를 확인하고(실패면 화면에 오류가 뜬다) 받은 본문을 파일로 저장한다.
    expect(f.callsTo(new RegExp(`^/builds/${BUILD_KEY}/download$`))).toHaveLength(1);
    expect(clicked[0].download).toBe("data.csv");

    // manifest 요약
    await user.click(within(card).getByRole("button", { name: "manifest 보기" }));
    await f.waitForApi(new RegExp(`^/builds/${BUILD_KEY}/manifest`));
    const summary = await screen.findByLabelText("manifest 요약");
    const kv = within(summary).getAllByRole("definition").map((d) => d.textContent);
    expect(kv.slice(0, 3)).toEqual(["1개", "2개", "120행"]);
    expect(summary.textContent).toContain("공정 데이터 표준 v3");
    expect(within(summary).getByText("공정데이터_A양식 v2")).toBeTruthy();
    expect(container.textContent).not.toMatch(UUID_RE);
    expect(container.textContent).not.toMatch(SHA_RE);

    // 새 빌드는 초안과 출력 설정을 비우고 1단계로 돌아간다
    await user.click(within(card).getByRole("button", { name: "새 빌드" }));
    expect(getBuildDraft().document_ids).toEqual([]);
    expect(sessionStorage.getItem(BUILD_COLUMNS_KEY)).toBeNull();
    expect(route().get("step")).toBeNull();
    await screen.findByRole("button", { name: "문서 화면에서 선택" });
  });

  it("긴 빌드는 작업 상태를 폴링해 진행률을 보여주고 완료되면 결과 카드를 보여준다", async () => {
    const f = buildFixture({ schemaKey: SCHEMA_KEY, asyncBuild: true });
    f.renderApp("?screen=build&step=5");
    await screen.findByRole("radiogroup", { name: "출력 형식" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "파일 생성" }));
    await screen.findByText(/빌드 진행 중… 진행 중 1\/3/);
    expect(screen.getByRole("button", { name: "파일 생성" }).hasAttribute("disabled")).toBe(true);
    const card = await screen.findByLabelText("빌드 결과", {}, { timeout: 4000 });
    expect(f.buildState.jobPolls).toBeGreaterThanOrEqual(1);
    expect(within(card).getByText("data.xlsx")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 생성" }).hasAttribute("disabled")).toBe(false);
  });
});
