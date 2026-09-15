import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UUID_RE, ids, page } from "./fixture";
import { GENERIC_DEFINITION, NEW_PROFILE_ID, SCHEMA_KEY, profileDocumentRows, profilesFixture } from "./profiles-fixture";

const route = () => new URLSearchParams(location.search);
const detailSection = () => screen.getByRole("region", { name: "프로파일 상세" });

describe("파싱 프로파일 화면", () => {
  it("목록은 §7 열과 상태 칩을 보여주고 상태 필터·검색(250ms)은 URL과 API에 반영되며, 만들기 버튼은 '+ 새 프로파일' 하나다", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles");
    const table = await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["프로파일명", "버전", "연결 스키마", "적용 문서 수", "상태", "최근 수정"]);
    expect(within(table).getAllByText("승인", { selector: ".app-chip" })).toHaveLength(1);
    expect(within(table).getAllByText("초안", { selector: ".app-chip" })).toHaveLength(1);
    expect(within(table).getByText("v2")).toBeTruthy();
    expect(within(table).getAllByText("공정 데이터 표준")).toHaveLength(2);
    // 같은 대화상자를 제목만 바꿔 띄우던 '외부 Profile Import' 버튼은 없다.
    expect(screen.queryByRole("button", { name: "외부 Profile Import" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "+ 새 프로파일" }).length).toBeGreaterThan(0);
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

  it("행을 열면 탭 없이 한 화면(요약줄 · 정의 JSON 편집기 · 변경 이력)을 보여주고 진입 호출은 3개다", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공정데이터_A양식" }));
    expect(route().get("profile")).toBe(ids.profile);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    await within(section).findByLabelText("프로파일 JSON");
    // 탭은 전부 사라졌다
    expect(screen.queryByRole("tablist", { name: "프로파일 상세 탭" })).toBeNull();
    for (const label of ["기본 정보", "규칙", "필드 매핑", "JSON"]) expect(within(section).queryByRole("tab", { name: label })).toBeNull();
    expect(screen.queryByRole("table", { name: "필드 매핑" })).toBeNull();
    expect(screen.queryByRole("table", { name: "적용 문서" })).toBeNull();

    expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe("공정데이터_A양식 v2");
    const summary = within(section).getByLabelText("프로파일 요약");
    expect(summary.textContent).toContain("공정 데이터 표준");
    expect(summary.textContent).toContain("공정데이터_2024_01.xlsx r2");
    expect(summary.textContent).toContain("5개");
    expect(within(summary).getByText("자동 승인", { selector: ".app-chip" })).toBeTruthy();
    expect(within(section).getByText("승인", { selector: ".app-chip" })).toBeTruthy();
    // 진입 호출: 상세 + 현재 리비전 정의 + 변경 이력 (적용 문서는 팝오버를 열 때만)
    expect(f.calls.filter((c) => c.path.startsWith(`/profiles/${ids.profile}`)).map((c) => c.path).sort()).toEqual(
      [`/profiles/${ids.profile}`, `/profiles/${ids.profile}/revisions/2`, `/profiles/${ids.profile}/revisions`].sort(),
    );
    expect(within(section).getByRole("table", { name: "변경 이력" })).toBeTruthy();
    expect((await within(section).findByLabelText("프로파일 JSON")).textContent).toContain('"format": "parsing-profile"');
    expect(section.textContent).not.toMatch(UUID_RE);
    // 왼쪽 목록은 좁은 목록으로 접힌다
    expect(screen.queryByRole("table", { name: "파싱 프로파일 목록" })).toBeNull();
  });

  it("'대표 문서 지정' 팝오버는 매핑을 모두 승인한 적용 건만 보여주고, 누르면 낙관적으로 승인 칩·대표 문서로 바뀌며 POST /approve를 보낸다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile2}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    await within(section).findByLabelText("프로파일 JSON");
    expect(within(section).getAllByText("초안", { selector: ".app-chip" }).length).toBeGreaterThan(0);
    expect(within(section).getByLabelText("프로파일 요약").textContent).toContain("없음");
    // 적용 문서는 팝오버를 열기 전에는 읽지 않는다
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile2}/documents`))).toHaveLength(0);

    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "대표 문서 지정" }));
    const popover = await screen.findByRole("group", { name: "대표 문서 지정" });
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile2}/documents`));
    const rows = await within(popover).findAllByRole("button", { name: "이 문서로 승인" });
    // 검수 1/2인 문서는 후보가 아니다
    expect(rows).toHaveLength(1);
    expect(popover.textContent).toContain("공정데이터_2024_01.xlsx");
    expect(popover.textContent).not.toContain("공정데이터_2024_02.xlsx");

    await user.click(rows[0]);
    await waitFor(() => expect(f.profiles.approved).toHaveLength(1));
    expect(f.profiles.approved[0]).toEqual({ id: ids.profile2, application_id: ids.application });
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile2}/approve`), "POST")).toHaveLength(1);
    await waitFor(() => expect(within(section).getAllByText("승인", { selector: ".app-chip" }).length).toBeGreaterThan(0));
    expect(within(section).queryAllByText("초안", { selector: ".app-chip" })).toHaveLength(0);
    expect(within(section).getByLabelText("프로파일 요약").textContent).toContain("공정데이터_2024_01.xlsx r2");
    expect(await screen.findByText("공정데이터_2024_01.xlsx을(를) 대표 문서로 승인했습니다. 재파싱(rematch)이 이어서 진행됩니다.")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("group", { name: "대표 문서 지정" })).toBeNull());
    expect(section.textContent).not.toMatch(UUID_RE);
  });

  it("팝오버는 Escape·닫기로 닫히고 초점을 연 버튼으로 되돌린다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    const opener = await within(section).findByRole("button", { name: "대표 문서 지정" });

    // 팝오버 안으로 초점이 들어간 뒤 Escape — 초점이 body로 떨어지면 Tab이 화면 맨 위로 돌아간다.
    await user.click(opener);
    const popover = await screen.findByRole("group", { name: "대표 문서 지정" });
    (within(popover).getByRole("button", { name: "닫기" }) as HTMLElement).focus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "대표 문서 지정" })).toBeNull());
    expect(document.activeElement).toBe(opener);

    // 닫기(×) 버튼도 같다.
    await user.click(opener);
    const again = await screen.findByRole("group", { name: "대표 문서 지정" });
    await user.click(within(again).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: "대표 문서 지정" })).toBeNull());
    expect(document.activeElement).toBe(opener);

    // 여는 버튼에 초점이 있는 채로 눌러도 Escape로 닫힌다(그때는 초점을 뺏지 않는다).
    await user.click(opener);
    await screen.findByRole("group", { name: "대표 문서 지정" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("group", { name: "대표 문서 지정" })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("승인 후보가 없으면 팝오버가 그 이유를 안내한다", async () => {
    const f = profilesFixture();
    // 검수가 끝나지 않은 적용 건만 있다
    f.overrides.set(`GET /profiles/${ids.profile2}/documents`, () => page([profileDocumentRows()[1]]));
    f.renderApp(`?screen=profiles&profile=${ids.profile2}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    await user.click(await within(section).findByRole("button", { name: "대표 문서 지정" }));
    await screen.findByText("승인할 수 있는 적용 건이 없습니다 — 문서를 검수해 매핑을 모두 승인한 뒤 다시 시도하세요.");
    expect(within(screen.getByRole("group", { name: "대표 문서 지정" })).queryByRole("button", { name: "이 문서로 승인" })).toBeNull();
  });

  it("승인 실패(422)는 낙관적 갱신을 되돌리고 오류를 보여준다", async () => {
    const f = profilesFixture();
    f.overrides.set(`POST /profiles/${ids.profile2}/approve`, () => ({ __status: 422, body: { error: { code: "REFERENCE_MISMATCH", message: "기준 문서와 서명이 다릅니다." } } }));
    f.renderApp(`?screen=profiles&profile=${ids.profile2}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    await user.click(await within(section).findByRole("button", { name: "대표 문서 지정" }));
    const popover = await screen.findByRole("group", { name: "대표 문서 지정" });
    await user.click(await within(popover).findByRole("button", { name: "이 문서로 승인" }));
    expect((await within(popover).findByRole("alert")).textContent).toContain("기준 문서와 서명이 다릅니다.");
    expect(within(section).getAllByText("초안", { selector: ".app-chip" }).length).toBeGreaterThan(0);
    expect(within(section).queryAllByText("승인", { selector: ".app-chip" })).toHaveLength(0);
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

  it("'테스트'는 적용 문서·검색 결과에서 문서를 골라 ?test=<profile_id>&snapshot=<sid>로 이동한다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const user = userEvent.setup();
    await user.click(await within(section).findByRole("button", { name: "테스트" }));
    const popover = await screen.findByRole("group", { name: "테스트 문서 고르기" });
    const run = within(popover).getByRole("button", { name: "테스트 실행" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    await user.type(within(popover).getByLabelText("문서 검색"), "구양식");
    await f.waitForApi(/^\/documents\?.*q=/);
    const found = await within(popover).findByRole("radiogroup", { name: "검색 결과" });
    expect(within(found).getByRole("radio", { name: "구양식_2019_07.xlsx" })).toBeTruthy();
    await user.click(within(within(popover).getByRole("radiogroup", { name: "적용 문서" })).getByRole("radio", { name: "공정데이터_2024_02.xlsx" }));
    await user.click(within(popover).getByRole("button", { name: "테스트 실행" }));
    expect(route().get("test")).toBe(ids.profile);
    expect(route().get("snapshot")).toBe(f.profiles.documents[1].snapshot.snapshot_id);
    expect(route().get("review")).toBeNull();
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("정의 JSON 편집기는 문법 오류를 즉시, 검증 오류·경고를 400ms 뒤 자동으로 보여주고 오류가 있으면 저장을 막는다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const editor = (await within(section).findByLabelText("프로파일 JSON")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"format": "parsing-profile"'));
    expect(within(section).getAllByRole("status").map((s) => s.textContent).join()).toContain("현재 리비전 v2과 같습니다.");
    // 따로 누르는 '검증' 버튼은 없다
    expect(within(section).queryByRole("button", { name: "검증" })).toBeNull();

    fireEvent.change(editor, { target: { value: '{"format": "parsing-profile", ' } });
    expect(within(section).getByRole("alert").textContent).toMatch(/JSON 문법 오류/);
    expect(editor.getAttribute("aria-invalid")).toBe("true");
    expect((within(section).getByRole("button", { name: "저장(새 리비전)" }) as HTMLButtonElement).disabled).toBe(true);

    const user = userEvent.setup();
    fireEvent.change(editor, { target: { value: JSON.stringify({ format: "parsing-profile", schema_key: SCHEMA_KEY, rules: [], __invalid: true }) } });
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    expect(f.callsTo(/^\/profiles\/import-preview/, "POST")[0].body).toEqual({ schema_key: SCHEMA_KEY, definition: { format: "parsing-profile", schema_key: SCHEMA_KEY, rules: [], __invalid: true } });
    const errors = await within(section).findByRole("list", { name: "오류" });
    expect(errors.textContent).toContain("INVALID_SELECTOR · rules[0].selector.value · 값 선택자가 비어 있습니다.");
    expect(within(section).getByText("오류 1", { selector: ".app-chip" })).toBeTruthy();
    // 오류가 있으면 저장 비활성
    await waitFor(() => expect((within(section).getByRole("button", { name: "저장(새 리비전)" }) as HTMLButtonElement).disabled).toBe(true));

    // 되돌리기는 편집기를 현재 리비전으로 되돌린다
    await user.click(within(section).getByRole("button", { name: "되돌리기" }));
    await waitFor(() => expect((within(section).getByLabelText("프로파일 JSON") as HTMLTextAreaElement).value).toContain('"profile_name"'));
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT")).toHaveLength(0);
  });

  it("'저장(새 리비전)'은 PUT으로 새 리비전을 만들고 헤더 vN·토스트를 갱신한다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const editor = (await within(section).findByLabelText("프로파일 JSON")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"format": "parsing-profile"'));
    const next = { ...f.profiles.definitions.get(ids.profile)!, description: "수정된 설명" };
    fireEvent.change(editor, { target: { value: JSON.stringify(next) } });
    await waitFor(() => expect(within(section).getAllByRole("status").map((s) => s.textContent).join()).toContain("저장되지 않은 변경이 있습니다."));
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "저장(새 리비전)" }));
    await waitFor(() => expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT")).toHaveLength(1));
    expect(f.callsTo(new RegExp(`^/profiles/${ids.profile}$`), "PUT")[0].body).toEqual({ definition: next });
    expect(await screen.findByText("공정데이터_A양식 v3 저장됨")).toBeTruthy();
    await waitFor(() => expect(within(section).getByRole("heading", { level: 2 }).textContent).toBe("공정데이터_A양식 v3"));
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/revisions/3$`));
  });

  it("하단 변경 이력의 '이 리비전 보기'는 그 리비전 JSON을 읽기 전용으로 연다", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    const history = await within(section).findByRole("table", { name: "변경 이력" });
    expect(within(history).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["리비전", "시각", "규칙", "행동"]);
    expect(within(history).getByText("규칙 4개")).toBeTruthy();

    const user = userEvent.setup();
    await user.click(within(history).getAllByRole("button", { name: "이 리비전 보기" })[1]);
    expect(route().get("rev")).toBe("1");
    await f.waitForApi(new RegExp(`^/profiles/${ids.profile}/revisions/1$`));
    expect(await within(section).findByText(/리비전 v1을\(를\) 읽기 전용으로/)).toBeTruthy();
    await waitFor(() => expect((within(section).getByLabelText("프로파일 JSON") as HTMLTextAreaElement).readOnly).toBe(true));
    expect((within(section).getByRole("button", { name: "저장(새 리비전)" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(section).getByRole("button", { name: /현재 리비전\(v2\)으로 돌아가기/ }));
    expect(route().get("rev")).toBeNull();
    await waitFor(() => expect((within(section).getByLabelText("프로파일 JSON") as HTMLTextAreaElement).readOnly).toBe(false));
    expect(section.textContent).not.toMatch(UUID_RE);
  });

  it("적용된 문서가 있는 프로파일에는 '삭제'가 없고 '폐기'만 있다(§4.2.1)", async () => {
    const f = profilesFixture();
    f.renderApp(`?screen=profiles&profile=${ids.profile}`);
    const section = await screen.findByRole("region", { name: "프로파일 상세" });
    await within(section).findByRole("button", { name: "폐기" });
    expect(within(section).queryByRole("button", { name: "삭제" })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: "폐기" }));
    // 프로파일 폐기는 되돌릴 수 없다 — 스키마 폐기와 같은 확인 대화상자를 쓰고 그 사실을 문구에 담는다.
    const dialog = await screen.findByRole("dialog", { name: "프로파일 폐기" });
    expect(dialog.textContent).toContain("되돌릴 수 없습니다");
    await user.click(within(dialog.querySelector(".app-modal-actions") as HTMLElement).getByRole("button", { name: "폐기" }));
    await waitFor(() => expect(f.profiles.deprecated).toEqual([ids.profile]));
    expect(await screen.findByText(/프로파일을 폐기했습니다/)).toBeTruthy();
  });

  it("'+ 새 프로파일' 대화상자는 빈 골격으로 시작하거나 붙여넣은 정의의 형식을 판별해 POST /profiles로 저장한다(테스트 버튼 없음)", async () => {
    const f = profilesFixture();
    const { container } = f.renderApp("?screen=profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("button", { name: "+ 새 프로파일" })[0]);
    const dialog = await screen.findByRole("dialog", { name: "새 프로파일" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(".app-main > div")?.hasAttribute("inert")).toBe(true);
    expect(dialog.textContent).toContain("저장한 뒤 상세 화면에서 문서를 골라 테스트하세요.");
    expect(within(dialog).queryByRole("button", { name: "대표 문서로 테스트" })).toBeNull();
    expect(within(dialog).queryByLabelText("테스트 문서")).toBeNull();
    await f.waitForApi(/^\/schemas/);
    // 스키마 선택은 목록 기본(활성)만 읽는다 — 폐기 스키마에는 새 프로파일을 만들 수 없다(§4.2.3).
    expect(f.callsTo(/^\/schemas(\?|$)/)[0].url.searchParams.get("status")).toBeNull();
    await waitFor(() => expect((within(dialog).getByLabelText("파싱 스키마") as HTMLSelectElement).value).toBe(SCHEMA_KEY));
    expect(within(dialog).getByLabelText("파일 업로드").getAttribute("type")).toBe("file");
    const editor = within(dialog).getByLabelText("정의 JSON") as HTMLTextAreaElement;
    // 기본은 '빈 골격으로 시작'
    const starts = within(dialog).getByRole("radiogroup", { name: "시작 방법" });
    expect((within(starts).getByRole("radio", { name: "빈 골격으로 시작" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(editor.value).toContain('"schema_version": "3.0"'));
    expect(editor.value).toContain(`"schema_key": "${SCHEMA_KEY}"`);
    await f.waitForApi(/^\/profiles\/import-preview/, "POST");
    expect(within(await within(dialog).findByRole("region", { name: "변환 미리보기" })).getByText("오류 없음", { selector: ".app-chip" })).toBeTruthy();

    await user.click(within(starts).getByRole("radio", { name: "정의 붙여넣기 또는 파일 업로드" }));
    await waitFor(() => expect(editor.value).toBe(""));
    expect((within(dialog).getByRole("button", { name: "저장" }) as HTMLButtonElement).disabled).toBe(true);

    // 외부 정의 붙여넣기 → 형식 자동 판별
    fireEvent.change(editor, { target: { value: "{not json" } });
    expect(within(dialog).getByRole("alert").textContent).toMatch(/JSON 문법 오류/);
    fireEvent.change(editor, { target: { value: JSON.stringify(GENERIC_DEFINITION) } });
    await f.waitForApi(/^\/profiles\/import-preview/, "POST", 2);
    const previewCall = f.callsTo(/^\/profiles\/import-preview/, "POST").at(-1)!;
    expect(previewCall.body).toEqual({ schema_key: SCHEMA_KEY, definition: GENERIC_DEFINITION, format: "auto" });
    const preview = await within(dialog).findByRole("region", { name: "변환 미리보기" });
    await within(preview).findByText("generic-keyvalue", { selector: ".app-chip" });
    const warnings = within(preview).getByRole("list", { name: "경고" });
    expect(within(warnings).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "KEY_INFERRED · fields[1] · 키를 필드명으로 추정했습니다.",
      "MISSING_FIELD · fields[0] · 연결할 필드가 지정되지 않았습니다.",
    ]);
    expect((within(preview).getByLabelText("canonical 미리보기") as HTMLTextAreaElement).readOnly).toBe(true);
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

  it("작업 내역의 '프로파일 만들기'(?import=1)는 대화상자를 열고, 닫으면 import를 지운다", async () => {
    const f = profilesFixture();
    f.renderApp("?screen=profiles&import=1");
    const dialog = await screen.findByRole("dialog", { name: "새 프로파일" });
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "새 프로파일" })).toBeNull());
    expect(route().get("import")).toBeNull();
    expect(route().get("screen")).toBe("profiles");
    await screen.findByRole("table", { name: "파싱 프로파일 목록" });
  });
});
