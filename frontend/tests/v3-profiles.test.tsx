import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PROFILE_DRAFT_KEY } from "../src/v3/profileDraft";
import { UUID_RE, ids } from "./v3-fixture";
import { GENERIC_DEFINITION, NEW_PROFILE_ID, SCHEMA_KEY, profilesFixture } from "./v3-profiles-fixture";

const route = () => new URLSearchParams(location.search);
const detailSection = () => screen.getByRole("region", { name: "프로파일 상세" });

describe("v3 파싱 프로파일 화면", () => {
  it("목록은 §7 열과 상태 칩을 보여주고 상태 필터·검색(250ms)은 URL과 API에 반영된다", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles");
    const table = await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["프로파일명", "버전", "연결 스키마", "적용 문서 수", "상태", "최근 수정"]);
    expect(within(table).getAllByText("승인", { selector: ".v3-chip" })).toHaveLength(1);
    expect(within(table).getAllByText("초안", { selector: ".v3-chip" })).toHaveLength(1);
    expect(within(table).getByText("v2")).toBeTruthy();
    expect(within(table).getAllByText("공정 데이터 표준")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "외부 Profile Import" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "새 프로파일" })).toBeTruthy();
    expect(f.callsTo(/^\/profiles\?/)[0].url.searchParams.get("limit")).toBe("50");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("상태"), "draft");
    expect(route().get("status")).toBe("draft");
    await f.waitForApi(/^\/profiles\?.*status=draft/);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "파싱 프로파일 목록" })).getAllByRole("row")).toHaveLength(2));
    expect(screen.getByRole("button", { name: "공정데이터_B양식" })).toBeTruthy();

    await user.selectOptions(screen.getByLabelText("상태"), "");
    await user.type(screen.getByLabelText("프로파일 검색"), "A양식");
    await f.waitForApi(/^\/profiles\?.*q=A/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.callsTo(/^\/profiles\?/).filter((c) => c.url.searchParams.get("q"))).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "파싱 프로파일 목록" })).getAllByRole("row")).toHaveLength(2));
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("행을 열면 ?profile=와 6개 탭, 기본 정보(대표 문서·자동 승인·시트 역할·적용 문서)를 보여주고 진입 호출은 ≤3", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공정데이터_A양식" }));
    expect(route().get("profile")).toBe(ids.profile);
    const tabs = await screen.findByRole("tablist", { name: "프로파일 상세 탭" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["기본 정보", "규칙", "필드 매핑", "테스트", "JSON", "변경 이력"]);
    const section = detailSection();
    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe("공정데이터_A양식 v2");
    expect(section.textContent).toContain("공정데이터_2024_01.xlsx r2");
    expect(within(section).getByText("활성", { selector: ".v3-chip" })).toBeTruthy();
    expect(within(within(section).getByRole("list", { name: "시트 역할" })).getByText("main")).toBeTruthy();
    const docs = await within(section).findByRole("table", { name: "적용 문서" });
    expect(within(docs).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "Snapshot", "호환", "검수", "발행", "대표", "상태", "행동"]);
    expect(within(docs).getByText("동일")).toBeTruthy();
    expect(within(docs).getAllByText("호환")).toHaveLength(2);
    expect(within(docs).getByText("r2 · 2026-09-14")).toBeTruthy();
    expect(within(docs).getAllByRole("button", { name: "Source Review 열기" })).toHaveLength(2);
    // 진입 호출: 상세 + 적용 문서 (목록은 이미 읽음)
    expect(f.calls.filter((c) => c.path.startsWith(`/profiles/${ids.profile}`)).length).toBeLessThanOrEqual(3);
    expect(section.textContent).not.toMatch(UUID_RE);
    // 왼쪽 목록은 좁은 목록으로 접힌다
    expect(screen.queryByRole("table", { name: "파싱 프로파일 목록" })).toBeNull();
    expect(screen.getByRole("button", { name: /공정데이터_B양식/ }).getAttribute("aria-current")).toBeNull();

    await user.click(within(docs).getAllByRole("button", { name: "Source Review 열기" })[1]);
    expect(route().get("review")).toBe(f.profiles.documents[1].application_id);
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("'이 문서로 승인'은 헤드가 전부 승인된 행에만 보이고, 누르면 낙관적으로 승인 칩·대표 표시로 바뀌며 POST /approve를 보낸다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile2}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const docs = await within(section).findByRole("table", { name: "적용 문서" });
    expect(within(section).getAllByText("초안", { selector: ".v3-chip" }).length).toBeGreaterThan(0);
    expect(within(section).queryAllByText("승인", { selector: ".v3-chip" })).toHaveLength(0);
    expect(section.textContent).toContain("없음");
    const approveButtons = within(docs).getAllByRole("button", { name: "이 문서로 승인" });
    expect(approveButtons).toHaveLength(1);
    expect(within(approveButtons[0].closest("tr")!).getByText("2/2")).toBeTruthy();
    expect(within(docs).queryByText("대표", { selector: ".v3-chip" })).toBeNull();

    const user = userEvent.setup();
    await user.click(approveButtons[0]);
    await waitFor(() => expect(f.profiles.approved).toHaveLength(1));
    expect(f.profiles.approved[0]).toEqual({ id: ids.profile2, application_id: ids.application });
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile2}/approve`), "POST")).toHaveLength(1);
    await waitFor(() => expect(within(section).getAllByText("승인", { selector: ".v3-chip" }).length).toBeGreaterThan(0));
    expect(within(section).queryAllByText("초안", { selector: ".v3-chip" })).toHaveLength(0);
    expect(within(within(section).getByRole("table", { name: "적용 문서" })).getByText("대표", { selector: ".v3-chip" })).toBeTruthy();
    expect(section.textContent).toContain("공정데이터_2024_01.xlsx r2");
    expect(within(section).queryByRole("button", { name: "이 문서로 승인" })).toBeNull();
    expect(section.textContent).not.toMatch(UUID_RE);
  });

  it("승인 실패(422)는 낙관적 갱신을 되돌리고 오류를 보여준다; 재파싱은 ?wait=10 작업 결과를 토스트로 알린다", async () => {
    const f = profilesFixture();
    f.overrides.set(`POST /profiles/${ids.profile2}/approve`, () => ({ __status: 422, body: { error: { code: "REFERENCE_MISMATCH", message: "기준 문서와 서명이 다릅니다." } } }));
    f.renderApp(`?screen=profiles&profile=${ids.profile2}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    await user.click(await within(section).findByRole("button", { name: "이 문서로 승인" }));
    expect((await within(section).findByRole("alert")).textContent).toContain("기준 문서와 서명이 다릅니다.");
    expect(within(section).getAllByText("초안", { selector: ".v3-chip" }).length).toBeGreaterThan(0);
    expect(within(section).queryAllByText("승인", { selector: ".v3-chip" })).toHaveLength(0);
    expect(within(section).getByRole("button", { name: "이 문서로 승인" })).toBeTruthy();
    expect(within(within(section).getByRole("table", { name: "적용 문서" })).queryByText("대표", { selector: ".v3-chip" })).toBeNull();
    // 초안은 재파싱 불가
    expect((within(section).getByRole("button", { name: "재파싱(rematch)" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("승인된 프로파일의 재파싱은 POST /reparse?wait=10 작업 결과를 토스트로 알린다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const approved = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    await user.click(await within(approved).findByRole("button", { name: "재파싱(rematch)" }));
    await waitFor(() => expect(f.profiles.reparsed).toEqual([{ id: ids.profile, mode: "rematch" }]));
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}/reparse\\?wait=10`), "POST")).toHaveLength(1);
    expect(await screen.findByText(/재파싱\(rematch\) 완료 · 3건 처리 · 1건 건너뜀/)).toBeTruthy();
  });

  it("필드 매핑 탭은 미지정 규칙을 강조하고, 규칙 탭은 카드와 폼으로 canonical JSON을 고쳐 PUT /profiles/{id}로 저장한다", async () => {
    const f = profilesFixture();
    const detail = f.overrides.get(`GET /profiles/${ids.profile}`)!;
    f.overrides.set(`GET /profiles/${ids.profile}`, (call) => {
      const data = detail(call) as any;
      return { ...data, rules: data.rules.map((r: any, i: number) => (i === 1 ? { ...r, field: null } : r)) };
    });
    f.renderApp(`?screen=profiles&profile=${ids.profile}&tab=mapping`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const mapping = await within(section).findByRole("table", { name: "필드 매핑" });
    expect(within(mapping).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["파싱 규칙", "필드", "타입", "단위", "상태"]);
    const rows = within(mapping).getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("data-unmapped")).toBeNull();
    expect(rows[1].getAttribute("data-unmapped")).toBe("true");
    expect(within(rows[1]).getByText("미지정", { selector: ".v3-chip" })).toBeTruthy();
    expect((within(section).getByRole("status")).textContent).toContain("필드가 지정되지 않은 파싱 규칙 1개");

    const user = userEvent.setup();
    await user.click(within(section).getByRole("tab", { name: "규칙" }));
    expect(route().get("tab")).toBe("rules");
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/revisions/2$`));
    const card = await within(section).findByRole("article", { name: "온도" });
    expect(card.textContent).toContain("anchor hdr_temp");
    expect(card.textContent).toContain("relative (+1, +0) 65×1");
    expect(card.textContent).toContain("list down");
    expect(card.textContent).toContain("decimal · °C · 원값 유지");
    expect(within(card).getByText("→ 온도", { selector: ".v3-chip" })).toBeTruthy();
    expect(within(within(section).getByRole("article", { name: "압력" })).getByText("→ pressure", { selector: ".v3-chip" })).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "편집" }));
    const form = await within(section).findByRole("form", { name: "규칙 편집" });
    expect((within(form).getByLabelText("규칙 키") as HTMLInputElement).value).toBe("temperature");
    expect((within(form).getByLabelText("값 위치 종류") as HTMLSelectElement).value).toBe("relative");
    expect((within(form).getByLabelText("키 위치 종류") as HTMLSelectElement).value).toBe("anchor");
    await f.waitForApi(/^\/normalization-presets/);
    await f.waitForApi(new RegExp(`^/schemas/${SCHEMA_KEY}/tree`));
    const unit = within(form).getByLabelText("단위") as HTMLInputElement;
    await user.clear(unit);
    await user.type(unit, "K");
    await user.selectOptions(within(form).getByLabelText("값 개수"), "scalar");
    await user.selectOptions(within(form).getByLabelText("값 위치 종류"), "range");
    fireEvent.change(within(form).getByLabelText("값 범위"), { target: { value: "C3:C7" } });
    await user.selectOptions(await within(form).findByLabelText("정규화 프리셋"), "identity");
    await user.click(within(form).getByRole("button", { name: "규칙 저장" }));
    await waitFor(() => expect(f.profiles.saved).toHaveLength(1));
    const put = f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT");
    expect(put).toHaveLength(1);
    const saved = put[0].body!.definition;
    expect(saved.rules[0].value_spec).toEqual({ type: "decimal", unit: "K", normalization: { operation: "identity" } });
    expect(saved.rules[0].selector.value).toEqual({ areas: [{ sheet_role: "main", range: "C3:C7" }], cardinality: "scalar", axis: "down" });
    expect(saved.rules[0].selector.key).toEqual({ areas: [{ sheet_role: "main", anchor: "hdr_temp" }], repeat: "once" });
    expect(saved.rules[1]).toEqual(f.profiles.definitions.get(ids.profile)!.rules[1]);
    expect(await screen.findByText(/v3 저장됨/)).toBeTruthy();
    await waitFor(() => expect(within(section).queryByRole("form")).toBeNull());
  });

  it("테스트 탭은 적용 문서·검색 결과에서 문서를 골라 ?test=<profile_id>&snapshot=<sid>로 이동한다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}&tab=test`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const run = await within(section).findByRole("button", { name: "테스트 실행" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    const user = userEvent.setup();
    await user.type(within(section).getByLabelText("문서 검색"), "구양식");
    await f.waitForApi(/^\/documents\?.*q=/);
    const found = await within(section).findByRole("radiogroup", { name: "검색 결과" });
    expect(within(found).getByRole("radio", { name: "구양식_2019_07.xlsx" })).toBeTruthy();
    await user.click(within(within(section).getByRole("radiogroup", { name: "적용 문서" })).getByRole("radio", { name: "공정데이터_2024_02.xlsx" }));
    await user.click(within(section).getByRole("button", { name: "테스트 실행" }));
    expect(route().get("test")).toBe(ids.profile);
    expect(route().get("snapshot")).toBe(f.profiles.documents[1].snapshot.snapshot_id);
    expect(route().get("review")).toBeNull();
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("JSON 탭은 문법 오류를 즉시 보여주고, 검증은 import-preview 오류를, 미저장 정의로 테스트는 draft 저장소와 ?test=draft를 쓴다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}&tab=json`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const editor = (await within(section).findByLabelText("프로파일 JSON")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"format": "parsing-profile"'));
    expect((within(section).getByRole("status")).textContent).toContain("현재 리비전 v2과 같습니다.");

    fireEvent.change(editor, { target: { value: '{"format": "parsing-profile", ' } });
    expect((within(section).getByRole("alert")).textContent).toMatch(/JSON 문법 오류/);
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect((within(section).getByRole("button", { name: "새 리비전 저장" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(section).getByRole("button", { name: "검증" }) as HTMLButtonElement).disabled).toBe(true);

    const user = userEvent.setup();
    fireEvent.change(editor, { target: { value: JSON.stringify({ format: "parsing-profile", schema_key: SCHEMA_KEY, rules: [], __invalid: true }) } });
    expect(within(section).queryByRole("alert")).toBeNull();
    expect((within(section).getByRole("status")).textContent).toContain("저장되지 않은 변경이 있습니다.");
    await user.click(within(section).getByRole("button", { name: "검증" }));
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    expect(f.callsTo(/^\/profiles\/import-preview/, "POST")[0].body).toEqual({ schema_key: SCHEMA_KEY, definition: { format: "parsing-profile", schema_key: SCHEMA_KEY, rules: [], __invalid: true } });
    const errors = await within(section).findByRole("list", { name: "오류" });
    expect(errors.textContent).toContain("INVALID_SELECTOR · rules[0].selector.value · 값 선택자가 비어 있습니다.");
    expect(within(section).getByText("오류 1", { selector: ".v3-chip" })).toBeTruthy();

    // 테스트 문서는 대표 문서(적용 문서 목록)에서 고른다
    expect((within(section).getByLabelText("테스트 문서") as HTMLSelectElement).value).toBe(ids.snapshot);
    await user.click(within(section).getByRole("button", { name: "미저장 정의로 테스트" }));
    expect(route().get("test")).toBe("draft");
    expect(route().get("snapshot")).toBe(ids.snapshot);
    const draft = JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY) || "{}");
    expect(draft.schema_key).toBe(SCHEMA_KEY);
    expect(draft.definition.__invalid).toBe(true);
    expect(draft.profile_name).toBe("공정데이터_A양식");
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("JSON 탭에서 새 리비전 저장은 PUT을 보내고, 변경 이력의 '이 리비전 보기'는 그 리비전 JSON을 읽기 전용으로 연다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}&tab=json`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const editor = (await within(section).findByLabelText("프로파일 JSON")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"format"'));
    const next = { ...f.profiles.definitions.get(ids.profile)!, description: "수정된 설명" };
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } });
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "새 리비전 저장" }));
    await waitFor(() => expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT")).toHaveLength(1));
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT")[0].body).toEqual({ definition: next });
    expect(await screen.findByText("공정데이터_A양식 v3 저장됨")).toBeTruthy();
    await waitFor(() => expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe("공정데이터_A양식 v3"));
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/revisions/3$`));

    await user.click(within(section).getByRole("tab", { name: "변경 이력" }));
    const history = await within(section).findByRole("table", { name: "변경 이력" });
    expect(within(history).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["리비전", "시각", "작성자", "요약", "행동"]);
    expect(within(history).getByText("규칙 추가")).toBeTruthy();
    await user.click(within(history).getAllByRole("button", { name: "이 리비전 보기" })[1]);
    expect(route().get("tab")).toBe("json");
    expect(route().get("rev")).toBe("1");
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/revisions/1$`));
    expect(await within(section).findByText(/리비전 v1을\(를\) 읽기 전용으로/)).toBeTruthy();
    await waitFor(() => expect((within(section).getByLabelText("프로파일 JSON") as HTMLTextAreaElement).readOnly).toBe(true));
    expect((within(section).getByRole("button", { name: "새 리비전 저장" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(section).getByRole("button", { name: /현재 리비전\(v3\)으로 돌아가기/ }));
    expect(route().get("rev")).toBeNull();
    await waitFor(() => expect((within(section).getByLabelText("프로파일 JSON") as HTMLTextAreaElement).readOnly).toBe(false));
    expect(section.textContent).not.toMatch(UUID_RE);
  });

  it("외부 Profile Import 대화상자는 붙여넣은 JSON의 형식을 판별해 canonical 미리보기와 경고를 보여주고 POST /profiles로 저장한다", async () => {
    const f = profilesFixture();
    const { container } = f.renderApp("?screen=profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "외부 Profile Import" }));
    const dialog = await screen.findByRole("dialog", { name: "외부 Profile Import" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(".v3-main > div")?.hasAttribute("inert")).toBe(true);
    await f.waitForApi(/^\/schemas/);
    await waitFor(() => expect((within(dialog).getByLabelText("파싱 스키마") as HTMLSelectElement).value).toBe(SCHEMA_KEY));
    expect(within(dialog).getByLabelText("파일 업로드").getAttribute("type")).toBe("file");
    expect((within(dialog).getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(true);

    const editor = within(dialog).getByLabelText("정의 JSON") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "{not json" } });
    expect((within(dialog).getByRole("alert")).textContent).toMatch(/JSON 문법 오류/);
    fireEvent.change(editor, { target: { value: JSON.stringify(GENERIC_DEFINITION) } });
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    const previewCall = f.callsTo(/^\/profiles\/import-preview/, "POST")[0];
    expect(previewCall.body).toEqual({ schema_key: SCHEMA_KEY, definition: GENERIC_DEFINITION, format: "auto" });
    const preview = await within(dialog).findByRole("region", { name: "변환 미리보기" });
    expect(within(preview).getByText("generic-keyvalue", { selector: ".v3-chip" })).toBeTruthy();
    const warnings = within(preview).getByRole("list", { name: "경고" });
    expect(within(warnings).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "KEY_INFERRED · fields[1] · 키를 필드명으로 추정했습니다.",
      "MISSING_FIELD · fields[0] · 연결할 필드가 지정되지 않았습니다.",
    ]);
    expect(within(preview).getByText("경고 2", { selector: ".v3-chip" })).toBeTruthy();
    expect((within(preview).getByLabelText("canonical 미리보기") as HTMLTextAreaElement).value).toContain('"format": "parsing-profile"');
    expect((within(preview).getByLabelText("canonical 미리보기") as HTMLTextAreaElement).readOnly).toBe(true);
    // 대표 문서로 테스트 후보 문서를 읽는다
    await f.waitForApi(/^\/documents\?/);
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "대표 문서로 테스트" }) as HTMLButtonElement).disabled).toBe(false));
    expect(dialog.textContent).not.toMatch(UUID_RE);

    await user.type(within(dialog).getByLabelText("프로파일명"), "가져온 양식");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(f.callsTo(/^\/profiles$/, "POST")).toHaveLength(1));
    expect(f.callsTo(/^\/profiles$/, "POST")[0].body).toEqual({ schema_key: SCHEMA_KEY, definition: GENERIC_DEFINITION, format: "auto", name: "가져온 양식" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(route().get("profile")).toBe(NEW_PROFILE_ID);
    expect(await screen.findByText("가져온 양식 v1 저장됨")).toBeTruthy();
    await waitFor(() => expect(within(detailSection()).getByRole("heading", { level: 2 }).textContent).toBe("가져온 양식 v1"));
  });

  it("Import 대화상자의 '대표 문서로 테스트'는 canonical을 draft 저장소에 두고 ?test=draft로 이동하며, '새 프로파일'은 3.0 골격으로 시작한다", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "새 프로파일" }));
    const dialog = await screen.findByRole("dialog", { name: "새 프로파일" });
    const editor = within(dialog).getByLabelText("정의 JSON") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"schema_version": "3.0"'));
    expect(editor.value).toContain(`"schema_key": "${SCHEMA_KEY}"`);
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    const preview = await within(dialog).findByRole("region", { name: "변환 미리보기" });
    expect(within(preview).getByText("오류 없음", { selector: ".v3-chip" })).toBeTruthy();
    const secondSnapshot = f.state.documents[1].current_snapshot!.snapshot_id;
    await user.selectOptions(await within(dialog).findByLabelText("테스트 문서"), secondSnapshot);
    await user.click(within(dialog).getByRole("button", { name: "대표 문서로 테스트" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 프로파일" })).toBeNull());
    expect(route().get("test")).toBe("draft");
    expect(route().get("snapshot")).toBe(secondSnapshot);
    const draft = JSON.parse(sessionStorage.getItem(PROFILE_DRAFT_KEY) || "{}");
    expect(draft.schema_key).toBe(SCHEMA_KEY);
    expect(draft.definition.format).toBe("parsing-profile");
    expect(draft.format).toBe("parsing-profile-3.0");
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("작업 내역의 '프로파일 만들기'(?import=1&snapshot=)는 Import 대화상자를 열고 그 문서를 테스트 문서로 미리 고르며, 닫으면 import·snapshot을 지운다", async () => {
    const f = profilesFixture();
    const secondSnapshot = f.state.documents[1].current_snapshot!.snapshot_id;
    f.renderApp(`?screen=profiles&import=1&snapshot=${secondSnapshot}`);
    const dialog = await screen.findByRole("dialog", { name: "외부 Profile Import" });
    const user = userEvent.setup();
    fireEvent.change(within(dialog).getByLabelText("정의 JSON"), { target: { value: JSON.stringify(GENERIC_DEFINITION) } });
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    const select = (await within(dialog).findByLabelText("테스트 문서")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe(secondSnapshot));
    expect(dialog.textContent).not.toMatch(UUID_RE);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "외부 Profile Import" })).toBeNull());
    expect(route().get("import")).toBeNull();
    expect(route().get("snapshot")).toBeNull();
    expect(route().get("screen")).toBe("profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
  });
});
