import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { page, workbenchFixture } from "./workbench-fixture";

const params = () => new URLSearchParams(location.search);
const table = async () =>
  within(await screen.findByRole("table", { name: "등록 문서 목록" }));
const documentCalls = (f: ReturnType<typeof workbenchFixture>) =>
  f.calls.filter((c) => c.path === "/documents");

describe("파일 분석 목록 표", () => {
  it("v1 형식의 목록 표와 배지를 표시한다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    render(<Workbench />);
    const t = await table();
    const headers = [
      "파일",
      "작성자",
      "작성일",
      "문서군",
      "템플릿",
      "검수",
      "접근",
      "상태",
      "열기",
    ];
    // 정렬 표시(▲▼)는 aria-hidden이라 접근성 이름에는 들어가지 않는다.
    expect(
      t
        .getAllByRole("columnheader")
        .map((h) => h.textContent?.replace(/[▲▼]/g, "")),
    ).toEqual(headers);
    for (const name of headers)
      expect(t.getByRole("columnheader", { name })).toBeTruthy();
    const first = within(t.getByRole("row", { name: /가상 공정.xlsx/ }));
    const firstCells = first.getAllByRole("cell").map((c) => c.textContent);
    expect(firstCells).toEqual([
      "가상 공정.xlsxlocal-xlsx · XLSX",
      "홍길동",
      "2026-09-08",
      "공정품질",
      "공정 운전 기록 v1",
      "—",
      "접근 가능",
      "발행됨",
      "열어보기",
    ]);
    expect(first.getByTitle("문서군 · 공정").className).toContain("outline");
    expect(first.getByTitle("파싱 템플릿 · 발행됨").className).toContain(
      "green",
    );
    expect(first.getByText("접근 가능").className).toContain("green");
    expect(first.getByText("발행됨").className).toContain("green");
    expect(first.getByRole("button", { name: "열어보기" })).toBeTruthy();

    const second = within(t.getByRole("row", { name: /가상 검수.xlsx/ }));
    const secondCells = second.getAllByRole("cell").map((c) => c.textContent);
    expect(secondCells).toEqual([
      "가상 검수.xlsxprotected-reader · XLSX",
      "—",
      "—",
      "—",
      "공정 운전 기록 v1",
      "1건 검수",
      "미확인",
      "검수 필요",
      "열어보기",
    ]);
    expect(second.getByTitle("파싱 템플릿 · 검수 필요").className).toContain(
      "amber",
    );
    expect(second.getByRole("button", { name: "1건 검수" })).toBeTruthy();
    expect(second.getByText("미확인").className).toContain("amber");
    expect(second.getByText("검수 필요").className).toContain("amber");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain(
      "2건 표시",
    );
    // 목록은 메타데이터만 쓴다: 문서를 열기 전에는 시트·버전 조회가 없다.
    expect(f.calls.some((c) => /\/sheets$|\/versions$/.test(c.path))).toBe(
      false,
    );
  });

  it("서버가 8개까지만 보낸 문서군은 나머지 개수를 +N으로 표시하고, 새 필드가 없는 행도 그린다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    f.overrides.set("GET /documents", () =>
      page([
        {
          document_id: "many",
          current_version_id: "many-v",
          display_name: "다수 문서군.xlsx",
          provider: "local-xlsx",
          file_type: "xlsx",
          author: "김철수",
          authored_at: "2026-01-02T00:00:00",
          access_status: "allowed",
          extraction_status: "published",
          templates: [],
          template_count: 0,
          review_pending: 0,
          roots: Array.from({ length: 8 }, (_, n) => ({
            concept_id: `root-${n}`,
            name: `문서군 ${n}`,
          })),
          root_count: 10,
        },
        {
          document_id: "legacy",
          current_version_id: "legacy-v",
          display_name: "이전 서버.xlsx",
          provider: "local-xlsx",
          file_type: "xlsx",
        },
      ]),
    );
    render(<Workbench />);
    const t = await table();
    const many = within(t.getByRole("row", { name: /다수 문서군.xlsx/ }));
    expect(many.getByText("문서군 7")).toBeTruthy();
    expect(many.getByText("+2")).toBeTruthy();
    expect(many.queryByText("문서군 8")).toBeNull();
    expect(many.getByText("미배정")).toBeTruthy();
    const legacy = within(t.getByRole("row", { name: /이전 서버.xlsx/ }));
    expect(legacy.getAllByRole("cell").map((c) => c.textContent)).toEqual([
      "이전 서버.xlsxlocal-xlsx · XLSX",
      "—",
      "—",
      "—",
      "미배정",
      "—",
      "미확인",
      "미배정",
      "열어보기",
    ]);
  });

  it("헤더를 클릭하면 서버 정렬 파라미터와 aria-sort를 바꾼다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    render(<Workbench />);
    const t = await table();
    expect(
      t.getByRole("columnheader", { name: "파일" }).getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(
      t.getByRole("columnheader", { name: "문서군" }).getAttribute("aria-sort"),
    ).toBeNull();
    await user.click(t.getByRole("button", { name: "템플릿" }));
    await waitFor(() =>
      expect(
        documentCalls(f).some(
          (c) =>
            c.url.searchParams.get("sort") === "template" &&
            c.url.searchParams.get("direction") === "asc",
        ),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("columnheader", { name: "템플릿" })
        .getAttribute("aria-sort"),
    ).toBe("ascending");
    expect(
      screen
        .getByRole("columnheader", { name: "파일" })
        .getAttribute("aria-sort"),
    ).toBe("none");
    await user.click(screen.getByRole("button", { name: "템플릿" }));
    await waitFor(() =>
      expect(
        documentCalls(f).some(
          (c) =>
            c.url.searchParams.get("sort") === "template" &&
            c.url.searchParams.get("direction") === "desc",
        ),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("columnheader", { name: "템플릿" })
        .getAttribute("aria-sort"),
    ).toBe("descending");
    await user.click(screen.getByRole("button", { name: "검수" }));
    await waitFor(() =>
      expect(
        documentCalls(f).some(
          (c) =>
            c.url.searchParams.get("sort") === "review" &&
            c.url.searchParams.get("direction") === "desc",
        ),
      ).toBe(true),
    );
    expect(
      screen
        .getByRole("columnheader", { name: "검수" })
        .getAttribute("aria-sort"),
    ).toBe("descending");
    // 초기화는 필터만 비우고 정렬은 유지한다.
    await user.type(screen.getByLabelText("작성자", { exact: true }), "홍");
    await user.click(screen.getByRole("button", { name: "초기화" }));
    await waitFor(() => {
      const last = documentCalls(f).at(-1)!;
      expect(last.url.searchParams.get("author")).toBeNull();
      expect(last.url.searchParams.get("sort")).toBe("review");
    });
  });

  it("열어보기·행 클릭으로 드로어를 열고 닫으면 route.document를 지운다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    render(<Workbench />);
    const t = await table();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls.some((c) => c.path.endsWith("/sheets"))).toBe(false);
    await user.click(
      within(t.getByRole("row", { name: /가상 공정.xlsx/ })).getByRole(
        "button",
        { name: "열어보기" },
      ),
    );
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    const drawer = within(dialog);
    expect(params().get("document")).toBe(f.ids.document);
    expect(params().get("version")).toBe(f.ids.version);
    expect(drawer.getByRole("heading", { name: "등록 버전" })).toBeTruthy();
    expect(drawer.getByRole("heading", { name: "시트 선택" })).toBeTruthy();
    expect(
      drawer.getByRole("heading", { name: "같은 양식으로 보이는 문서군" }),
    ).toBeTruthy();
    expect(
      await drawer.findByRole("button", { name: /^공정 기록 · 68행/ }),
    ).toBeTruthy();
    expect(
      drawer.getByRole("button", { name: "원본 · 검수 열기 →" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("row", { name: /가상 공정.xlsx/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    // 드로어는 모달이다: 열린 동안 표·원본 등록·검수 큐는 inert이고 초점은 패널 안에서만 돈다.
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.closest("[inert]")).toBeNull();
    for (const behind of [
      screen.getByRole("table", { name: "등록 문서 목록" }),
      screen.getByText("원본 등록").closest("details")!,
      screen.getByRole("region", { name: "검수 큐" }),
    ])
      expect(behind.closest("[inert]")).not.toBeNull();
    expect(document.activeElement).toBe(dialog);
    // Shift+Tab은 패널에서 마지막 컨트롤(템플릿 연결 summary)로, 거기서 Tab은 첫 컨트롤로 돈다.
    // (jsdom은 inert를 구현하지 않으므로 순환은 드로어의 키 처리기가 맡는다.)
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      drawer.getByText("+ 이 문서 버전에 템플릿 연결"),
    );
    await user.tab();
    expect(document.activeElement).toBe(
      drawer.getByRole("button", { name: "원본 · 검수 열기 →" }),
    );
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      drawer.getByText("+ 이 문서 버전에 템플릿 연결"),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(params().get("document")).toBeNull();
    expect(params().get("version")).toBeNull();
    // 닫히면 inert가 풀리고 초점은 드로어를 연 버튼으로 돌아간다.
    expect(document.querySelector("[inert]")).toBeNull();
    expect(document.activeElement).toBe(
      within(screen.getByRole("row", { name: /가상 공정.xlsx/ })).getByRole(
        "button",
        { name: "열어보기" },
      ),
    );

    await user.click(screen.getByText("가상 공정.xlsx"));
    expect(
      await screen.findByRole("dialog", { name: "문서 상세" }),
    ).toBeTruthy();
    expect(params().get("document")).toBe(f.ids.document);
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(params().get("document")).toBeNull();

    // 행 안의 버튼(검수)을 눌러도 드로어는 열리지 않는다.
    await user.click(screen.getByText("가상 검수.xlsx"));
    await screen.findByRole("dialog", { name: "문서 상세" });
    expect(params().get("document")).toBe(`${f.ids.document}-b`);
    await user.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("검수 버튼은 원본 화면의 해당 적용 건으로 이동한다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    render(<Workbench />);
    const t = await table();
    await user.click(t.getByRole("button", { name: "1건 검수" }));
    await waitFor(() => expect(params().get("tab")).toBe("source"));
    expect(params().get("document")).toBe(`${f.ids.document}-b`);
    expect(params().get("version")).toBe(`${f.ids.version}-b`);
    // 픽스처의 검수 대기 적용 건 id는 app-<tag>-review이며 tag는 ids의 숫자 접미사다.
    const tag = f.ids.document.split("-")[1];
    expect(params().get("application")).toBe(`app-${tag}-review`);
    expect(params().get("mapping")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("원본 등록은 접힌 상태로 표 아래에 있고 검수 큐가 그 뒤에 온다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    render(<Workbench />);
    const t = await screen.findByRole("table", { name: "등록 문서 목록" });
    const register = screen.getByText("원본 등록").closest("details");
    expect(register).not.toBeNull();
    expect(register!.open).toBe(false);
    expect(screen.getByRole("button", { name: "문서 등록" })).toBeTruthy();
    expect(
      t.compareDocumentPosition(register!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const queue = screen.getByRole("region", { name: "검수 큐" });
    expect(
      register!.compareDocumentPosition(queue) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("문서 필터 · 정렬")).toBeNull();
    expect(screen.queryByLabelText("정렬 방향")).toBeNull();
    expect(screen.getByRole("search", { name: "문서 필터" })).toBeTruthy();
    expect(f.calls.some((c) => c.path === "/documents")).toBe(true);
  });
  it("Escape는 대화상자 안에서 눌렀을 때만 드로어를 닫는다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    render(<Workbench />);
    const t = await table();
    await user.click(
      within(t.getByRole("row", { name: /가상 공정.xlsx/ })).getByRole(
        "button",
        { name: "열어보기" },
      ),
    );
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    // jsdom은 inert를 구현하지 않으므로 대화상자 밖(필터 도구 모음·검수 큐·body)에 직접 키 이벤트를
    // 보내, 처리기가 문서 전체가 아니라 대화상자에만 걸려 있는지 확인한다.
    const search = screen.getByLabelText("문서 검색");
    expect(dialog.contains(search)).toBe(false);
    fireEvent.keyDown(search, { key: "Escape" });
    fireEvent.keyDown(screen.getByLabelText("검수 문서·규칙 검색"), {
      key: "Escape",
    });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "문서 상세" })).toBeTruthy();
    expect(params().get("document")).toBe(f.ids.document);
    // 드로어 안의 컨트롤(템플릿 연결 summary)에 초점을 두고 누른 Escape는 닫는다.
    await user.click(within(dialog).getByText("+ 이 문서 버전에 템플릿 연결"));
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(params().get("document")).toBeNull();
  });

  it("템플릿 배지는 상태별 색을 쓰고, 검수 버튼은 검수 대기 헤드가 있는 적용 건으로 이동한다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    const template = (
      application_id: string,
      name: string,
      state: string,
      extra: Record<string, unknown> = {},
    ) => ({
      application_id,
      template_id: `template-${name}`,
      template_version_id: `template-version-${name}`,
      name,
      revision_no: 1,
      state,
      ...extra,
    });
    f.overrides.set("GET /documents", () =>
      page([
        {
          document_id: "mixed",
          current_version_id: "mixed-v",
          display_name: "혼합 상태.xlsx",
          provider: "local-xlsx",
          file_type: "xlsx",
          author: null,
          authored_at: null,
          access_status: "allowed",
          extraction_status: "failed",
          templates: [
            // 이름순으로 먼저 오는 적용 건에는 검수 대기 헤드가 없다.
            template("app-pending", "가나다", "pending", {
              review_pending: 0,
              scope_key: "2차",
            }),
            // 실패한 실행 뒤 다시 제안된 헤드: state는 failed지만 검수 대상이다.
            template("app-failed", "공정온도", "failed", { review_pending: 1 }),
            // 이전 서버 응답(review_pending 없음)은 0으로 본다.
            template("app-legacy", "이전 서버", "review"),
          ],
          template_count: 3,
          review_pending: 1,
          roots: [],
          root_count: 0,
        },
      ]),
    );
    render(<Workbench />);
    const t = await table();
    const row = within(t.getByRole("row", { name: /혼합 상태.xlsx/ }));
    const failed = row.getByTitle("파싱 템플릿 · 실패");
    expect(failed.textContent).toBe("공정온도 v1");
    expect(failed.className).toContain("red");
    expect(failed.className).not.toContain("blue");
    // scope_key가 적용 건 id와 다르면 제목에 덧붙여 같은 템플릿의 중복 적용을 구분한다.
    expect(row.getByTitle("파싱 템플릿 · 추출 필요 · 2차").className).toContain(
      "blue",
    );
    expect(row.getByTitle("파싱 템플릿 · 검수 필요").className).toContain(
      "amber",
    );
    await user.click(row.getByRole("button", { name: "1건 검수" }));
    await waitFor(() => expect(params().get("tab")).toBe("source"));
    expect(params().get("document")).toBe("mixed");
    expect(params().get("version")).toBe("mixed-v");
    expect(params().get("application")).toBe("app-failed");
  });

  it("정렬을 바꿔 다시 불러오는 동안 직전 행은 남기고 건수는 비운다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    const row = (id: string, name: string) => ({
      document_id: id,
      current_version_id: `${id}-v`,
      display_name: name,
      provider: "local-xlsx",
      file_type: "xlsx",
    });
    let release: ((rows: Record<string, unknown>[]) => void) | undefined;
    f.overrides.set("GET /documents", (call) =>
      call.url.searchParams.get("sort") === "template"
        ? new Promise((resolve) => {
            release = (rows) => resolve(page(rows));
          })
        : page([row("a", "가.xlsx"), row("b", "나.xlsx")]),
    );
    render(<Workbench />);
    const t = await table();
    const count = document.querySelector(".v2-doc-count")!;
    expect(count.textContent).toBe("2건 표시 · 1 페이지");
    await user.click(t.getByRole("button", { name: "템플릿" }));
    await waitFor(() => expect(release).toBeDefined());
    const busy = screen.getByRole("table", { name: "등록 문서 목록" });
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(within(busy).getByRole("row", { name: /가.xlsx/ })).toBeTruthy();
    expect(within(busy).getByRole("row", { name: /나.xlsx/ })).toBeTruthy();
    // 직전 건수와 새 요청의 페이지 번호를 짝짓지 않는다: 건수는 비우고 라이브 영역만 남긴다.
    expect(count.textContent).toBe("");
    expect(
      screen
        .getAllByRole("status")
        .map((s) => s.textContent)
        .filter(Boolean),
    ).toEqual(["불러오는 중…"]);
    release!([row("c", "다.xlsx")]);
    expect(await screen.findByRole("row", { name: /다.xlsx/ })).toBeTruthy();
    expect(screen.queryByRole("row", { name: /가.xlsx/ })).toBeNull();
    expect(count.textContent).toBe("1건 표시 · 1 페이지");
    expect(
      screen
        .getByRole("table", { name: "등록 문서 목록" })
        .getAttribute("aria-busy"),
    ).toBeNull();
  });

  it("문서가 하나도 없으면 원본 등록을 펼치고 등록 안내를 보여준다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    f.overrides.set("GET /documents", () => page([]));
    render(<Workbench />);
    expect(
      await screen.findByText(
        "아직 등록된 문서가 없습니다. 아래 '원본 등록'에서 첫 문서를 등록하세요.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("table", { name: "등록 문서 목록" })).toBeNull();
    const title = screen.getByText("원본 등록");
    // summary는 disclosure 버튼으로 노출되므로 그 안의 제목은 heading이 아닌 span이다.
    expect(title.tagName).toBe("SPAN");
    expect(title.closest("summary")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "원본 등록" })).toBeNull();
    await waitFor(() => expect(title.closest("details")!.open).toBe(true));
    expect(screen.getByRole("button", { name: "문서 등록" })).toBeTruthy();
  });

  it("조건에 맞는 문서가 없을 때는 안내만 바꾸고 원본 등록은 펼치지 않는다", async () => {
    const f = workbenchFixture();
    f.open("documents", { document: "", version: "" });
    const user = userEvent.setup();
    f.overrides.set("GET /documents", (call) =>
      page(
        call.url.searchParams.get("q")
          ? []
          : [
              {
                document_id: "only",
                current_version_id: "only-v",
                display_name: "유일.xlsx",
                provider: "local-xlsx",
                file_type: "xlsx",
              },
            ],
      ),
    );
    render(<Workbench />);
    await table();
    const register = screen.getByText("원본 등록").closest("details")!;
    expect(register.open).toBe(false);
    await user.type(screen.getByLabelText("문서 검색"), "없음");
    await user.click(
      within(screen.getByRole("search", { name: "문서 필터" })).getByRole(
        "button",
        { name: "검색" },
      ),
    );
    expect(await screen.findByText("조건에 맞는 문서가 없습니다.")).toBeTruthy();
    expect(screen.queryByText(/첫 문서를 등록하세요/)).toBeNull();
    expect(register.open).toBe(false);
    await user.click(screen.getByRole("button", { name: "초기화" }));
    await table();
    expect(register.open).toBe(false);
  });
});
