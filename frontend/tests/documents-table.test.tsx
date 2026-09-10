import { render, screen, waitFor, within } from "@testing-library/react";
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
      "blue",
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
    expect(second.getByTitle("파싱 템플릿 · 검수 필요")).toBeTruthy();
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
    const drawer = within(
      await screen.findByRole("dialog", { name: "문서 상세" }),
    );
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
    // 드로어가 열려 있어도 검수 큐는 접근성 트리에 남는다(aria-modal·inert 없음).
    expect(screen.getByRole("region", { name: "검수 큐" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(params().get("document")).toBeNull();
    expect(params().get("version")).toBeNull();

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
});
