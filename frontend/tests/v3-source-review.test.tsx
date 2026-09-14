import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setProfileDraft } from "../src/v3/profileDraft";
import { SHA_RE, UUID_RE, ids } from "./v3-fixture";
import { sourceReviewFixture, testResult } from "./v3-source-review-fixture";

const APPLICATION_RE = /^\/applications\/[^/?]+$/;
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function openReview(f: ReturnType<typeof sourceReviewFixture>, extra = "") {
  const view = f.renderApp(f.reviewUrl(extra));
  await f.waitForApi(APPLICATION_RE);
  const dialog = await screen.findByRole("dialog", { name: "Source Review" });
  await waitFor(() => expect(dialog.querySelector('[data-ref="C3"]')).toBeTruthy());
  return { ...view, dialog, panel: within(screen.getByTestId("mapping-panel")) };
}

describe("Source Review — 검수 모드", () => {
  it("진입은 GET /applications/{aid} 1회이고 선택한 규칙의 원본 위치를 역할별 overlay로 그리며 ID를 노출하지 않는다", async () => {
    const f = sourceReviewFixture();
    const { dialog } = await openReview(f);
    expect(f.callsTo(APPLICATION_RE)).toHaveLength(1);
    // 컨텍스트 줄: 문서 · snapshot 날짜 · 프로파일 vN · 스키마 vN
    expect(dialog.textContent).toContain("공정데이터_2024_01.xlsx");
    expect(dialog.textContent).toContain("공정데이터_A양식 v2");
    expect(dialog.textContent).toContain("공정 데이터 표준 v3");
    // 시트 역할과 규칙 상태 칩
    const sheets = within(screen.getByRole("group", { name: "시트 목록" }));
    expect(sheets.getByText("역할: main")).toBeTruthy();
    const rules = within(screen.getByRole("group", { name: "파싱 규칙 목록" }));
    expect(rules.getAllByRole("button")).toHaveLength(2);
    expect(rules.getByRole("button", { name: /온도/ }).getAttribute("aria-current")).toBe("true");
    // overlay: key 1개 · value 1개(C3:C7)
    await waitFor(() => expect(dialog.querySelectorAll(".v3-overlay.value")).toHaveLength(1));
    expect(dialog.querySelectorAll(".v3-overlay.key")).toHaveLength(1);
    expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("C3:C7");
    expect(dialog.querySelector(".v3-overlay.key")?.getAttribute("data-range")).toBe("C2");
    expect(dialog.querySelectorAll(".v3-overlay.unit")).toHaveLength(0);
    // 우측 패널
    const panel = within(screen.getByTestId("mapping-panel"));
    expect(panel.getByText("온도(°C)")).toBeTruthy();
    expect(panel.getByText("102.1 °C")).toBeTruthy();
    expect(panel.getByRole("button", { name: "값: Sheet1!C3:C7" })).toBeTruthy();
    expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("approved");
    // 드래그 역할 선택기 · 확대 선택 · 셀 이동
    expect(screen.getByRole("group", { name: "선택 역할" })).toBeTruthy();
    expect(screen.getByLabelText("확대")).toBeTruthy();
    expect(screen.getByLabelText("셀 이동")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(UUID_RE);
    expect(document.body.textContent).not.toMatch(SHA_RE);
    // 접힌 상세는 펼치기 전까지 이력 호출이 없다
    expect(f.callsTo(/\/mappings\/[^/]+\/revisions/)).toHaveLength(0);
  });

  it("규칙을 클릭하면 추가 API 호출 없이 우측 패널과 overlay가 바뀐다", async () => {
    const f = sourceReviewFixture();
    const { dialog } = await openReview(f);
    await waitFor(() => expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("C3:C7"));
    const before = f.calls.length;
    fireEvent.click(within(screen.getByRole("group", { name: "파싱 규칙 목록" })).getByRole("button", { name: /압력/ }));
    await waitFor(() => expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("D3:D7"));
    expect(dialog.querySelector(".v3-overlay.key")?.getAttribute("data-range")).toBe("D2");
    const panel = within(screen.getByTestId("mapping-panel"));
    expect(panel.getByText("압력(bar)")).toBeTruthy();
    expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("proposed");
    expect(new URLSearchParams(location.search).get("rule")).toBe("pressure");
    await settle();
    expect(f.calls.length).toBe(before);
  });

  it("승인은 expected_seq·status·extract를 보내고 칩을 즉시 갱신한다(원본 위치가 그대로면 regions 없음)", async () => {
    const f = sourceReviewFixture();
    const { panel } = await openReview(f, "&rule=pressure");
    expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("proposed");
    fireEvent.click(panel.getByRole("button", { name: "승인" }));
    // 낙관적 갱신: 응답을 기다리지 않고 상태가 바뀐다
    expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("approved");
    await f.waitForApi(new RegExp(`^/mappings/${ids.mapping2}/revisions`), "POST");
    expect(f.review.revisions).toEqual([{ mapping_id: ids.mapping2, expected_seq: 1, status: "approved", extract: true }]);
    await screen.findByText("승인됨");
    // 다시 읽은 뒤에도 승인 상태이고 컨텍스트의 승인 수가 오른다
    await waitFor(() => expect(f.callsTo(APPLICATION_RE).length).toBe(2));
    await waitFor(() => expect(screen.getByText("승인 2/2")).toBeTruthy());
    const rules = within(screen.getByRole("group", { name: "파싱 규칙 목록" }));
    expect(within(rules.getByRole("button", { name: /압력/ })).getByText("승인")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("드래그로 다시 지정한 원본 위치는 역할별로 다음 리비전의 regions에 실린다", async () => {
    const f = sourceReviewFixture();
    const { dialog, panel } = await openReview(f, "&rule=pressure");
    fireEvent.click(within(screen.getByRole("group", { name: "선택 역할" })).getByRole("button", { name: "값" }));
    const e3 = dialog.querySelector<HTMLElement>('[data-ref="E3"]')!;
    const e7 = dialog.querySelector<HTMLElement>('[data-ref="E7"]')!;
    fireEvent.pointerDown(e3, { button: 0 });
    fireEvent.pointerOver(e7);
    fireEvent.pointerUp(e7);
    // 새 위치가 overlay와 패널에 바로 반영된다
    await waitFor(() => expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("E3:E7"));
    expect(panel.getByText("원본 위치 변경됨")).toBeTruthy();
    expect(panel.getByRole("button", { name: "값: Sheet1!E3:E7" })).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "승인" }));
    await f.waitForApi(new RegExp(`^/mappings/${ids.mapping2}/revisions`), "POST");
    expect(f.review.revisions[0]).toEqual({
      mapping_id: ids.mapping2,
      expected_seq: 1,
      status: "approved",
      regions: [
        { role: "key", sheet_id: ids.sheet1, range: "D2" },
        { role: "value", sheet_id: ids.sheet1, range: "E3:E7" },
      ],
      extract: true,
    });
    await waitFor(() => expect(panel.queryByText("원본 위치 변경됨")).toBeNull());
  });

  it("409 EDIT_CONFLICT면 되돌리고 최신 상태를 다시 읽으며 안내한다", async () => {
    const f = sourceReviewFixture();
    f.review.conflict = true;
    const { panel } = await openReview(f, "&rule=pressure");
    fireEvent.click(panel.getByRole("button", { name: "승인" }));
    expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("approved");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("먼저 수정");
    await waitFor(() => expect(f.callsTo(APPLICATION_RE).length).toBe(2));
    await waitFor(() => expect(screen.getByTestId("mapping-panel").dataset.mappingStatus).toBe("proposed"));
    expect(f.review.revisions).toHaveLength(1);
  });

  it("수정은 스키마 트리에서 필드를 고르고 field_key와 함께 저장한다", async () => {
    const f = sourceReviewFixture();
    const { panel } = await openReview(f, "&rule=pressure");
    fireEvent.click(panel.getByRole("button", { name: "수정" }));
    await f.waitForApi(/^\/schemas\/process_std\/tree/);
    const form = within(screen.getByRole("form", { name: "매핑 수정" }));
    await waitFor(() => expect(form.getByRole("option", { name: /공정 정보 › 온도/ })).toBeTruthy());
    fireEvent.change(form.getByLabelText("필드"), { target: { value: "temperature" } });
    fireEvent.change(form.getByLabelText("저장 상태"), { target: { value: "proposed" } });
    fireEvent.change(form.getByLabelText("사유"), { target: { value: "키 열이 바뀜" } });
    fireEvent.click(form.getByRole("button", { name: "저장" }));
    await f.waitForApi(new RegExp(`^/mappings/${ids.mapping2}/revisions`), "POST");
    expect(f.review.revisions[0]).toEqual({ mapping_id: ids.mapping2, expected_seq: 1, status: "proposed", field_key: "temperature", reason: "키 열이 바뀜", extract: true });
    await waitFor(() => expect(screen.queryByRole("form", { name: "매핑 수정" })).toBeNull());
    expect(f.callsTo(/^\/schemas\/process_std\/tree/)).toHaveLength(1);
  });

  it("모두 승인은 POST approve-all?wait=20 한 번으로 승인·추출하고 결과를 보여준다", async () => {
    const f = sourceReviewFixture();
    await openReview(f);
    const button = screen.getByRole("button", { name: "모두 승인 (1)" });
    fireEvent.click(button);
    // 낙관적 갱신: 제안 규칙이 즉시 승인으로
    const rules = within(screen.getByRole("group", { name: "파싱 규칙 목록" }));
    expect(within(rules.getByRole("button", { name: /압력/ })).getByText("승인")).toBeTruthy();
    await f.waitForApi(new RegExp(`^/applications/${ids.application}/approve-all\\?wait=20$`), "POST");
    expect(f.review.approveAll).toEqual([{ wait: "20", extract: true }]);
    const banner = await screen.findByTestId("approve-all-result");
    expect(banner.textContent).toContain("추출 완료");
    expect(banner.textContent).toContain("값 10개");
    expect(banner.textContent).toContain("발행됨");
    await waitFor(() => expect(screen.getByText("승인 2/2")).toBeTruthy());
    expect(screen.getByText("발행됨", { selector: ".v3-chip" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "모두 승인" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("변경 이력은 펼칠 때만 읽고 복원은 rollback을 보낸다", async () => {
    const f = sourceReviewFixture();
    const { dialog } = await openReview(f);
    expect(f.callsTo(/\/mappings\/[^/]+\/revisions/)).toHaveLength(0);
    const details = Array.from(dialog.querySelectorAll("details")).find((d) => d.textContent?.includes("변경 이력"))!;
    fireEvent.click(within(details).getByText("변경 이력"));
    if (!details.open) {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    }
    await f.waitForApi(new RegExp(`^/mappings/${ids.mapping1}/revisions`));
    const table = await screen.findByRole("table", { name: "변경 이력" });
    expect(within(table).getByText("현재")).toBeTruthy();
    expect(within(table).getByText("최초 자동 적용")).toBeTruthy();
    fireEvent.click(within(table).getByRole("button", { name: "복원" }));
    await f.waitForApi(new RegExp(`^/mappings/${ids.mapping1}/rollback`), "POST");
    expect(f.review.rollbacks).toEqual([{ mapping_id: ids.mapping1, expected_seq: 1, target_revision_id: expect.stringMatching(UUID_RE) }]);
    await screen.findByText("복원됨");
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("← 돌아가기와 Escape는 review·rule·range·snapshot 파라미터를 지운다", async () => {
    const f = sourceReviewFixture();
    await openReview(f, "&rule=pressure&range=D3%3AD7&snapshot=" + ids.snapshot);
    fireEvent.click(screen.getByRole("button", { name: "← 돌아가기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Source Review" })).toBeNull());
    const params = new URLSearchParams(location.search);
    expect(params.get("review")).toBeNull();
    expect(params.get("rule")).toBeNull();
    expect(params.get("range")).toBeNull();
    expect(params.get("snapshot")).toBeNull();
    expect(params.get("screen")).toBe("documents");

    const g = sourceReviewFixture();
    const { dialog } = await openReview(g);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Source Review" })).toBeNull());
    expect(new URLSearchParams(location.search).get("review")).toBeNull();
  });
});

describe("Source Review — 테스트 모드", () => {
  const testUrl = (profile: string, extra = "") => `?screen=documents&test=${profile}&snapshot=${ids.snapshot}${extra}`;

  it("진입 시 POST /profiles/{id}/test를 실행해 groups를 그리고 승인 관련 행동을 숨긴다", async () => {
    const f = sourceReviewFixture();
    f.renderApp(testUrl(ids.profile2));
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile2}/test`), "POST");
    expect(f.review.tests).toEqual([{ path: `/profiles/${ids.profile2}/test`, snapshot_id: ids.snapshot }]);
    const dialog = await screen.findByRole("dialog", { name: "Source Review" });
    await screen.findByTestId("test-panel");
    expect(dialog.textContent).toContain("공정데이터_B양식 v1");
    expect(within(dialog).getAllByText("테스트").length).toBeGreaterThan(0);
    // 좌측: 시트 역할(bindings) · 규칙(groups)
    expect(within(screen.getByRole("group", { name: "시트 목록" })).getByText("역할: main")).toBeTruthy();
    const rules = within(screen.getByRole("group", { name: "파싱 규칙 목록" }));
    expect(rules.getAllByRole("button")).toHaveLength(2);
    expect(rules.getByText("값 5")).toBeTruthy();
    expect(rules.getByText("값 0")).toBeTruthy();
    // 우측: 규칙·필드·관찰된 키·값 표(≤50)·개수
    const panel = within(screen.getByTestId("test-panel"));
    expect(panel.getByText("온도(°C)")).toBeTruthy();
    const table = panel.getByRole("table", { name: "테스트 값" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByRole("button", { name: "Sheet1!C5" })).toBeTruthy();
    expect(screen.queryByTestId("partial-banner")).toBeNull();
    // overlay는 선택한 group의 regions
    await waitFor(() => expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("C3:C7"));
    expect(dialog.querySelectorAll(".v3-overlay.key")).toHaveLength(1);
    // 승인·반려·수정·모두 승인·이력 없음, 행동은 닫기 · 다시 실행
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
    expect(screen.queryByRole("button", { name: "반려" })).toBeNull();
    expect(screen.queryByRole("button", { name: "수정" })).toBeNull();
    expect(screen.queryByRole("button", { name: /모두 승인/ })).toBeNull();
    expect(screen.queryByText("변경 이력")).toBeNull();
    expect(screen.getByRole("button", { name: "닫기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 실행" })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(UUID_RE);
    expect(document.body.textContent).not.toMatch(SHA_RE);
    // 규칙 클릭은 추가 호출 없음
    const before = f.calls.length;
    fireEvent.click(rules.getByRole("button", { name: /압력/ }));
    await waitFor(() => expect(dialog.querySelector(".v3-overlay.value")?.getAttribute("data-range")).toBe("D3:D7"));
    expect(within(screen.getByTestId("test-panel")).getByText("이 규칙에서 추출된 값이 없습니다.")).toBeTruthy();
    await settle();
    expect(f.calls.length).toBe(before);
  });

  it("TEST_TIMEOUT이면 부분 결과 배너를 보이고, 다시 실행은 같은 요청을 다시 보내며, 닫기는 test·snapshot을 지운다", async () => {
    const f = sourceReviewFixture();
    f.review.testResult = testResult({ errors: [{ code: "TEST_TIMEOUT", message: "20초 초과" }, { code: "SELECTOR_NOT_FOUND", message: "선택자가 셀을 찾지 못했습니다.", rule_key: "pressure" }] });
    f.renderApp(testUrl(ids.profile));
    await screen.findByTestId("partial-banner");
    expect(screen.getByRole("alert").textContent).toContain("선택자가 셀을 찾지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 실행" }));
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/test`), "POST", 2);
    await screen.findByTestId("test-panel");
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Source Review" })).toBeNull());
    const params = new URLSearchParams(location.search);
    expect(params.get("test")).toBeNull();
    expect(params.get("snapshot")).toBeNull();
  });

  it("test=draft는 profileDraft의 정의로 POST /profiles/test를 호출한다", async () => {
    const f = sourceReviewFixture();
    setProfileDraft({ schema_key: "process_std", definition: { version: "3.0", rules: [] }, profile_name: "새 양식" });
    f.renderApp(testUrl("draft"));
    await f.waitForApi(/^\/profiles\/test$/, "POST");
    expect(f.review.tests).toEqual([{ path: "/profiles/test", schema_key: "process_std", definition: { version: "3.0", rules: [] }, snapshot_id: ids.snapshot }]);
    await screen.findByTestId("test-panel");
    expect(screen.getByRole("dialog", { name: "Source Review" }).textContent).toContain("새 양식 (초안)");
    expect(f.callsTo(/^\/profiles\/[^/]+$/)).toHaveLength(0);
  });

  it("초안이 없으면 안내만 보이고 테스트를 실행하지 않는다", async () => {
    const f = sourceReviewFixture();
    setProfileDraft(null);
    f.renderApp(testUrl("draft"));
    await screen.findByRole("dialog", { name: "Source Review" });
    expect(screen.getByRole("alert").textContent).toContain("편집 중인 정의가 없습니다");
    await settle();
    expect(f.review.tests).toHaveLength(0);
  });
});
