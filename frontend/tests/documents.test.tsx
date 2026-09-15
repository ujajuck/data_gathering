import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { STATUS_LABELS, STATUS_ORDER } from "../src/app/types";
import { getBuildDraft } from "../src/app/buildDraft";
import { UUID_RE, errorBody, job, page, reply, appFixture } from "./fixture";
import { documentDeleteResult, documentsFixture, registerDirectoryResult } from "./documents-fixture";

const route = () => new URLSearchParams(location.search);
const documentsTable = () => screen.findByRole("table", { name: "문서 목록" });
const footer = (dialog: HTMLElement) => within(dialog.querySelector(".app-modal-actions") as HTMLElement);
const header = (name: RegExp) => within(screen.getByRole("table", { name: "문서 목록" })).getByRole("columnheader", { name });

describe("문서 화면", () => {
  it("7가지 상태 칩과 §7 열을 보여주고, 상태 필터는 URL과 API에 반영된다", async () => {
    const f = appFixture();
    f.renderApp("?screen=documents");
    const table = await screen.findByRole("table", { name: "문서 목록" });
    const headers = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers.slice(1)).toEqual(["문서명", "상태", "적용 프로파일", "연결 스키마", "현재 Snapshot", "최근 처리"]);
    for (const status of STATUS_ORDER) {
      const chips = within(table).getAllByText(STATUS_LABELS[status], { selector: ".app-chip" });
      expect(chips.length).toBeGreaterThan(0);
    }
    expect(within(table).getAllByText("최신").length).toBe(6);
    // 프로파일 2개인 문서는 첫 항목 +N
    expect(within(table).getByText("+1")).toBeTruthy();
    // 정렬 헤더: 첫 방향
    expect(within(table).getByRole("columnheader", { name: /최근 처리/ }).getAttribute("aria-sort")).toBe("descending");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("상태"), "review");
    expect(route().get("status")).toBe("review");
    await f.waitForApi(/^\/documents\?.*status=review/);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "문서 목록" })).getAllByRole("row")).toHaveLength(2));
  });

  it("문서 검색은 250ms 디바운스 뒤 한 번만 호출한다", async () => {
    const f = appFixture();
    f.renderApp("?screen=documents");
    await screen.findByRole("table", { name: "문서 목록" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("문서 검색"), "구양식");
    await f.waitForApi(/^\/documents\?.*q=%EA%B5%AC%EC%96%91%EC%8B%9D/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const searched = f.callsTo(/^\/documents\?/).filter((c) => c.url.searchParams.get("q"));
    expect(searched).toHaveLength(1);
    expect(searched[0].url.searchParams.get("limit")).toBe("50");
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
  });

  it("행 클릭은 모달 드로어를 열고, 파일 보기는 SheetViewer 셀(병합 1회)을, 다른 탭은 값·프로파일·스키마를 보여준다", async () => {
    const f = appFixture();
    const { container } = f.renderApp("?screen=documents");
    await screen.findByRole("table", { name: "문서 목록" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공정데이터_2024_01.xlsx" }));
    expect(route().get("document")).toBe(f.ids.document(1));
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.querySelector(".app-main")?.hasAttribute("inert")).toBe(false);
    expect(within(dialog).getAllByRole("tab").map((t) => t.textContent)).toEqual(["파일 보기", "추출 결과", "적용 프로파일", "연결 스키마"]);
    // 관계 카드
    expect(within(dialog).getByLabelText("문서 관계").textContent).toContain("공정데이터_A양식 v2");
    expect(within(dialog).getByLabelText("문서 관계").textContent).toContain("공정 데이터 표준");

    // 파일 보기: 시트 목록 + 첫 창(A1:Z60)
    await within(dialog).findByRole("button", { name: /온도실험/ });
    await f.waitForApi(new RegExp(`^/snapshots/${f.ids.snapshot}/sheets/${f.ids.sheet1}/render\\?range=A1%3AZ60`));
    const merged = await waitFor(() => {
      const cell = dialog.querySelector<HTMLElement>('[data-ref="A1"]');
      if (!cell) throw new Error("A1 not yet rendered");
      return cell;
    });
    expect(merged.textContent).toBe("공정 데이터 2024");
    expect(merged.dataset.range).toBe("A1:C1");
    expect(merged.style.width).toBe("240px");
    expect(dialog.querySelector('[data-ref="B1"]')).toBeNull();
    expect(dialog.querySelectorAll('[data-ref="A1"]')).toHaveLength(1);
    expect(dialog.querySelector('[data-ref="C2"]')?.textContent).toBe("온도(°C)");
    const img = dialog.querySelector("img.app-sheet-image");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(dialog.querySelectorAll(".app-cell").length).toBeLessThanOrEqual(3000);
    // 진입 호출 ≤ 3: 문서 상세 + 시트 목록 + 렌더 창
    const afterOpen = f.calls.filter((c) => c.path.startsWith(`/documents/${f.ids.document(1)}`) || c.path.startsWith(`/snapshots/${f.ids.snapshot}`));
    expect(afterOpen.length).toBeLessThanOrEqual(3);
    expect(dialog.textContent).not.toMatch(UUID_RE);

    // 시트 전환은 sheet= URL
    await user.click(within(dialog).getByRole("button", { name: /원가/ }));
    expect(route().get("sheet")).toBe(f.ids.sheet3);
    await f.waitForApi(new RegExp(`^/snapshots/${f.ids.snapshot}/sheets/${f.ids.sheet3}/render`));

    // 추출 결과
    await user.click(within(dialog).getByRole("tab", { name: "추출 결과" }));
    const values = await within(dialog).findByRole("table", { name: "추출 결과" });
    expect(within(values).getAllByText("Sheet1!C3").length).toBe(1);
    expect(within(values).getAllByRole("button", { name: "원본 보기" }).length).toBe(5);

    // 적용 프로파일
    await user.click(within(dialog).getByRole("tab", { name: "적용 프로파일" }));
    const profiles = await within(dialog).findByRole("table", { name: "적용 프로파일" });
    expect(within(profiles).getByText("공정데이터_A양식 v2")).toBeTruthy();
    expect(within(profiles).getByText("공정데이터_B양식 v1")).toBeTruthy();

    // 연결 스키마
    await user.click(within(dialog).getByRole("tab", { name: "연결 스키마" }));
    expect(await within(dialog).findByRole("button", { name: /공정 데이터 표준/ })).toBeTruthy();

    // Escape로 닫힌다
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(route().get("document")).toBeNull();
  });

  it("렌더 202는 뷰어 안에서만 '렌더링 중'을 보여주고 700ms 뒤 다시 요청해 200이면 셀을 그린다", async () => {
    const f = appFixture();
    let renders = 0;
    const path = `/snapshots/${f.ids.snapshot}/sheets/${f.ids.sheet1}/render`;
    f.overrides.set("GET " + path, (call) => {
      renders++;
      return renders === 1 ? reply(202, { status: "queued", job_id: f.ids.job, position: 1 }) : f.renderWindow(f.ids.sheet1, call.url.searchParams.get("range") || "A1:Z60");
    });
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}`);
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    await within(dialog).findByText("렌더링 중");
    // 다른 영역(시트 목록·관계 카드)은 그대로 보인다
    expect(within(dialog).getByLabelText("문서 관계")).toBeTruthy();
    await waitFor(() => expect(renders).toBe(2), { timeout: 3000 });
    await waitFor(() => expect(dialog.querySelector('[data-ref="C2"]')?.textContent).toBe("온도(°C)"));
    expect(within(dialog).queryByText("렌더링 중")).toBeNull();
  });

  it("'데이터 빌드에 추가'는 초안(sessionStorage)을 갱신하고 토스트를 보여준다", async () => {
    const f = appFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}`);
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(dialog).findByRole("button", { name: "데이터 빌드에 추가" }));
    expect(getBuildDraft().document_ids).toEqual([f.ids.document(1)]);
    expect(JSON.parse(sessionStorage.getItem("schema.build.draft")!).document_ids).toEqual([f.ids.document(1)]);
    expect(await screen.findByText(/1개 문서 · 데이터 빌드로 이동 ›/)).toBeTruthy();

    // 표에서 다중 선택 → 추가
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("checkbox", { name: "공정데이터_2024_02.xlsx 선택" }));
    await user.click(screen.getByRole("checkbox", { name: "공정데이터_2024_03.xlsx 선택" }));
    expect(screen.getByText("2개 선택")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "데이터 빌드에 추가" }));
    expect(getBuildDraft().document_ids).toEqual([f.ids.document(1), f.ids.document(2), f.ids.document(3)]);
    const toasts = screen.getAllByRole("button", { name: "데이터 빌드로 이동" });
    await user.click(toasts[toasts.length - 1]);
    expect(route().get("screen")).toBe("build");
    await screen.findByRole("heading", { name: "데이터 빌드" });
    await f.waitForApi(/^\/builds\/candidates/, "POST");
    expect(f.callsTo(/^\/builds\/candidates/, "POST")[0].body).toEqual({ document_ids: [f.ids.document(1), f.ids.document(2), f.ids.document(3)] });
    await screen.findByText(/입력 문서 3개 · 사용 가능 1개 · 제외 2개/);
  });

  it("'+ 문서 등록'은 폴더를 탐색해 파일을 고르고 POST /documents/register?wait=10 뒤 파일별 결과를 보여준다", async () => {
    const f = documentsFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ 문서 등록" }));
    const dialog = await screen.findByRole("dialog", { name: "문서 등록" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // 뒤 화면(목록)은 inert
    expect(screen.getByRole("table", { name: "문서 목록" }).closest("[inert]")).not.toBeNull();
    await f.waitForApi(/^\/sources/);
    const files = await within(dialog).findByRole("table", { name: "원본 파일 목록" });
    expect(within(files).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["", "이름", "크기", "수정"]);
    // 폴더 행에는 이름(이동)과 '전체 등록'(§4.1.1) 두 버튼이 있으므로 이름으로 정확히 고른다
    await user.click(within(files).getByRole("button", { name: "📁 2024" }));
    await f.waitForApi(/^\/sources\?directory=2024/);
    await user.click(await within(dialog).findByRole("checkbox", { name: "공정데이터_2024_05.xlsx" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "손상파일.xlsx" }));
    // 상위 폴더로 돌아가도 선택은 유지되고 다른 폴더의 파일을 더 고를 수 있다
    await user.click(within(dialog).getByRole("button", { name: "상위 폴더" }));
    await user.click(await within(dialog).findByRole("checkbox", { name: "샘플.xlsx" }));
    expect(within(dialog).getByText("3개 선택")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "공정데이터_2024_05.xlsx 선택 해제" })).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "3개 문서 등록" }));
    await f.waitForApi(/^\/documents\/register\?wait=10/, "POST");
    expect(f.registered).toHaveLength(1);
    expect(f.registered[0].body).toEqual({
      source_refs: ["2024/공정데이터_2024_05.xlsx", "2024/손상파일.xlsx", "샘플.xlsx"],
      provider: "local-xlsx",
    });
    const results = await within(dialog).findByRole("table", { name: "등록 결과" });
    expect(within(results).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "등록", "자동 적용", "상태", "실패 사유"]);
    const rows = within(results).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("공정데이터_2024_05.xlsx");
    expect(within(rows[0]).getByText("완료", { selector: ".app-chip" })).toBeTruthy();
    expect(rows[0].textContent).toContain("공정데이터_A양식 · 동일");
    expect(within(rows[0]).getByText("정상", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[1]).getByText("실패", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[1]).getByText("파싱 실패", { selector: ".app-chip" })).toBeTruthy();
    expect(rows[1].textContent).toContain("파일을 열 수 없습니다");
    expect(rows[1].textContent).toContain("없음");
    expect(dialog.textContent).not.toMatch(UUID_RE);
    expect(await screen.findByText("2개 문서 등록 · 1개 실패")).toBeTruthy();
    // 등록 뒤 목록을 다시 읽는다
    await f.waitForApi(/^\/documents\?/, "GET", 2);
    await user.click(footer(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await documentsTable()).closest("[inert]")).toBeNull();
  });

  it("등록 작업이 10초 뒤에도 진행 중이면 안내를 보여주고, 대화상자를 닫아도 JobBar에서 이어진다", async () => {
    const f = documentsFixture();
    const running = job({ kind: "register", state: "running", completed: 1, total: 3, result: null, finished_at: null, label: "문서 등록 3개" });
    f.overrides.set("POST /documents/register", () => {
      f.state.running.push(running);
      return running;
    });
    f.renderApp("?screen=documents");
    await documentsTable();
    expect(screen.queryByText(/진행 중 작업/)).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ 문서 등록" }));
    const dialog = await screen.findByRole("dialog", { name: "문서 등록" });
    await user.click(await within(dialog).findByRole("checkbox", { name: "샘플.xlsx" }));
    await user.click(within(dialog).getByRole("button", { name: "1개 문서 등록" }));
    await within(dialog).findByText(/등록 작업이 진행 중입니다 \(1\/3\)/);
    expect(within(within(dialog).getByRole("list", { name: "등록 중인 문서" })).getByText("샘플.xlsx")).toBeTruthy();
    expect(within(dialog).queryByRole("table", { name: "등록 결과" })).toBeNull();
    await user.click(footer(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("진행 중 작업 1");
  });

  it("정렬 헤더는 열마다 첫 방향으로 시작하고 다시 누르면 반전되며 ?sort=와 API에 반영된다", async () => {
    const f = appFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(within(await documentsTable()).getByRole("button", { name: "문서명" }));
    expect(route().get("sort")).toBe("document_name");
    await f.waitForApi(/^\/documents\?.*sort=document_name/);
    await waitFor(() => expect(header(/문서명/).getAttribute("aria-sort")).toBe("ascending"));
    expect(header(/최근 처리/).getAttribute("aria-sort")).toBe("none");
    expect(header(/적용 프로파일/).getAttribute("aria-sort")).toBeNull();
    const firstAsc = within(await documentsTable()).getAllByRole("row")[1].textContent;
    await user.click(within(await documentsTable()).getByRole("button", { name: "문서명" }));
    expect(route().get("sort")).toBe("-document_name");
    await f.waitForApi(/^\/documents\?.*sort=-document_name/);
    await waitFor(() => expect(header(/문서명/).getAttribute("aria-sort")).toBe("descending"));
    await waitFor(() => expect(within(screen.getByRole("table", { name: "문서 목록" })).getAllByRole("row")[1].textContent).not.toBe(firstAsc));
    // 상태는 오름차순부터, 최근 처리는 내림차순부터
    await user.click(within(await documentsTable()).getByRole("button", { name: "상태" }));
    expect(route().get("sort")).toBe("status");
    await waitFor(() => expect(header(/상태/).getAttribute("aria-sort")).toBe("ascending"));
    await user.click(within(await documentsTable()).getByRole("button", { name: "최근 처리" }));
    expect(route().get("sort")).toBe("-last_processed_at");
    await waitFor(() => expect(header(/최근 처리/).getAttribute("aria-sort")).toBe("descending"));
    await user.click(within(await documentsTable()).getByRole("button", { name: "최근 처리" }));
    expect(route().get("sort")).toBe("last_processed_at");
    await waitFor(() => expect(header(/최근 처리/).getAttribute("aria-sort")).toBe("ascending"));
    for (const call of f.callsTo(/^\/documents\?/)) expect(call.url.searchParams.get("limit")).toBe("50");
  });

  it("프로파일 필터는 GET /profiles로 채워지고 ?profile_id=와 API에 반영되며 '필터 해제'로 지운다", async () => {
    const f = appFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    await f.waitForApi(/^\/profiles/);
    const select = screen.getByLabelText("파싱 프로파일") as HTMLSelectElement;
    await waitFor(() => expect(within(select).getByRole("option", { name: "공정데이터_A양식 v2" })).toBeTruthy());
    expect(within(select).getByRole("option", { name: "공정데이터_B양식 v1" })).toBeTruthy();
    const user = userEvent.setup();
    await user.selectOptions(select, f.ids.profile);
    expect(route().get("profile_id")).toBe(f.ids.profile);
    await f.waitForApi(new RegExp(`^/documents\\?.*profile_id=${f.ids.profile}`));
    await user.click(screen.getByRole("button", { name: "필터 해제" }));
    expect(route().get("profile_id")).toBeNull();
    expect((screen.getByLabelText("파싱 프로파일") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "필터 해제" })).toBeNull();
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("빈 상태: 문서가 없으면 등록 안내와 '문서 등록하기', 필터 결과가 없으면 '필터 해제'를 보여준다", async () => {
    const f = documentsFixture();
    f.overrides.set("GET /documents", () => page([]));
    f.renderApp("?screen=documents");
    await screen.findByText(/아직 등록된 문서가 없습니다/);
    expect(screen.queryByRole("table", { name: "문서 목록" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "문서 등록하기" }));
    const dialog = await screen.findByRole("dialog", { name: "문서 등록" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.selectOptions(screen.getByLabelText("상태"), "failed");
    await screen.findByText("조건에 맞는 문서가 없습니다.");
    expect(screen.queryByRole("button", { name: "문서 등록하기" })).toBeNull();
    const clears = screen.getAllByRole("button", { name: "필터 해제" });
    await user.click(clears[clears.length - 1]);
    expect(route().get("status")).toBeNull();
    await screen.findByText(/아직 등록된 문서가 없습니다/);
  });

  it("'전체 선택'은 페이지의 문서를 모두 고르고 하단 바는 선택 수와 '데이터 빌드에 추가'를 보여준다", async () => {
    const f = appFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    expect(screen.queryByRole("region", { name: "선택한 문서" })).toBeNull();
    await user.click(screen.getByRole("checkbox", { name: "전체 선택" }));
    const bar = screen.getByRole("region", { name: "선택한 문서" });
    expect(within(bar).getByText("7개 선택")).toBeTruthy();
    expect(bar.classList.contains("app-sticky-bottom")).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "보안문서_2024.xlsx 선택" }));
    expect(within(bar).getByText("6개 선택")).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "전체 선택" }) as HTMLInputElement).checked).toBe(false);
    await user.click(within(bar).getByRole("button", { name: "데이터 빌드에 추가" }));
    expect(getBuildDraft().document_ids).toHaveLength(6);
    expect(await screen.findByText(/6개 문서 · 데이터 빌드로 이동 ›/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "선택한 문서" })).toBeNull();
  });

  it("상세: Snapshot 이력은 펼칠 때만 읽고, 추출 결과는 규칙 필터와 원본 보기(review/rule/sheet/range)를 제공한다", async () => {
    const f = appFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}`);
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    await within(dialog).findByRole("button", { name: /온도실험/ });
    expect(f.callsTo(/^\/documents\/[^/]+\/snapshots/)).toHaveLength(0);
    expect(within(dialog).getByText(/현재 Snapshot/).textContent).toContain("2026-09-14");
    const user = userEvent.setup();
    await user.click(within(dialog).getByText(/Snapshot 이력/));
    await f.waitForApi(/^\/documents\/[^/]+\/snapshots/);
    const list = await within(dialog).findByRole("list", { name: "Snapshot 목록" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["r2 · 2026-09-14최신", "r1 · 2026-09-04"]);
    expect(dialog.textContent).not.toMatch(UUID_RE);

    await user.click(within(dialog).getByRole("tab", { name: "추출 결과" }));
    const values = await within(dialog).findByRole("table", { name: "추출 결과" });
    expect(within(values).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["필드", "파싱 규칙", "값", "단위", "원본 위치", "행동"]);
    expect(within(values).getAllByRole("row")[1].textContent).toContain("온도");
    expect(within(values).getAllByRole("row")[1].textContent).toContain("°C");
    expect(f.callsTo(/^\/snapshots\/[^/]+\/values\?/)[0].url.searchParams.get("limit")).toBe("50");
    await user.selectOptions(await within(dialog).findByLabelText("파싱 규칙"), "temperature");
    await f.waitForApi(/^\/snapshots\/[^/]+\/values\?.*rule_key=temperature/);
    const firstRow = within(await within(dialog).findByRole("table", { name: "추출 결과" })).getAllByRole("row")[1];
    await user.click(within(firstRow).getByRole("button", { name: "원본 보기" }));
    expect(route().get("review")).toBe(f.ids.application);
    expect(route().get("rule")).toBe("temperature");
    expect(route().get("sheet")).toBe(f.ids.sheet1);
    expect(route().get("range")).toBe("C3");
    await screen.findByRole("dialog", { name: "Source Review" });
  });

  it("적용 프로파일 탭은 검수·발행을 보강하고, '다른 프로파일로 파싱'은 프로파일을 골라 POST /snapshots/{sid}/applications?wait=10을 보낸다", async () => {
    const f = appFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}&tab=profiles`);
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    const table = await within(dialog).findByRole("table", { name: "적용 프로파일" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["프로파일", "상태", "호환", "검수", "발행", "행동"]);
    await f.waitForApi(new RegExp(`^/snapshots/${f.ids.snapshot}/applications`));
    await waitFor(() => expect(within(dialog).getByRole("table", { name: "적용 프로파일" }).textContent).toContain("1/2"));
    const rows = within(within(dialog).getByRole("table", { name: "적용 프로파일" })).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("승인", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[0]).getByText("발행", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[0]).getByText("동일")).toBeTruthy();
    expect(within(rows[1]).getByText("검수 필요", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[1]).getByText("호환")).toBeTruthy();
    expect(within(rows[0]).getAllByRole("button").map((b) => b.textContent)).toEqual(["원본 보기", "프로파일 열기"]);
    // 진입 호출 ≤ 3: 문서 상세 + 적용 목록
    expect(f.calls.filter((c) => c.path.startsWith(`/documents/${f.ids.document(1)}`) || c.path.startsWith(`/snapshots/${f.ids.snapshot}`)).length).toBeLessThanOrEqual(3);
    expect(dialog.textContent).not.toMatch(UUID_RE);

    const user = userEvent.setup();
    await user.click(within(dialog).getAllByRole("button", { name: "다른 프로파일로 파싱" })[0]);
    const picker = await within(dialog).findByRole("group", { name: "다른 프로파일로 파싱" });
    await f.waitForApi(/^\/profiles/);
    await waitFor(() => expect(within(picker).getByRole("option", { name: /공정데이터_B양식 v1/ })).toBeTruthy());
    expect(within(picker).getByRole("button", { name: "파싱 실행" }).hasAttribute("disabled")).toBe(true);
    await user.selectOptions(within(picker).getByLabelText("파싱 프로파일"), f.ids.profile2);
    await user.click(within(picker).getByRole("button", { name: "파싱 실행" }));
    await f.waitForApi(new RegExp(`^/snapshots/${f.ids.snapshot}/applications\\?wait=10`), "POST");
    expect(f.state.applied).toEqual([{ profile_id: f.ids.profile2 }]);
    await screen.findByText("파싱을 적용했습니다.");
    await waitFor(() => expect(within(dialog).queryByRole("group", { name: "다른 프로파일로 파싱" })).toBeNull());
    // 문서 상세는 다시 읽는다
    await f.waitForApi(new RegExp(`^/documents/${f.ids.document(1)}$`), "GET", 2);
    const toasts = document.querySelector(".app-toasts") as HTMLElement;
    await user.click(within(toasts).getByRole("button", { name: "원본 보기" }));
    expect(route().get("review")).toBe(f.ids.application2);
  });

  it("Snapshot이 없는 문서(잠김)는 원본 보기·파싱을 비활성화하고 이유를 보여준다", async () => {
    const f = appFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(7)}`);
    const dialog = await screen.findByRole("dialog", { name: "문서 상세" });
    await within(dialog).findByText("Snapshot 없음");
    expect(within(dialog).getByText("잠김(DRM)", { selector: ".app-chip" })).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain("DRM Reader가 필요합니다.");
    expect(within(dialog).getByRole("button", { name: "원본 보기" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "다른 프로파일로 파싱" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/현재 Snapshot이 없어 파일을 보여줄 수 없습니다/)).toBeTruthy();
    expect(within(dialog).getByLabelText("문서 관계").textContent).toContain("없음");
    expect(f.callsTo(/^\/snapshots\//)).toHaveLength(0);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(route().get("document")).toBeNull();
  });
});

describe("폴더 일괄 등록(§4.1.1)", () => {
  // 등록 대화상자를 열고 원본 폴더 목록까지 그린다.
  async function openRegister() {
    const f = documentsFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ 문서 등록" }));
    const dialog = await screen.findByRole("dialog", { name: "문서 등록" });
    await f.waitForApi(/^\/sources$/);
    await within(dialog).findByRole("table", { name: "원본 파일 목록" });
    return { f, user, dialog };
  }
  const startButton = (dialog: HTMLElement) => footer(dialog).getByRole("button", { name: /등록 시작/ });

  it("'이 폴더 전체 등록'은 폴더를 한 번만 스캔해 미리보기를 보여주고, 체크박스는 재조회 없이 대상 수를 바꾼다", async () => {
    const { f, user, dialog } = await openRegister();
    await user.click(within(dialog).getByRole("button", { name: "📁 2024" }));
    await f.waitForApi(/^\/sources\?directory=2024/);
    await user.click(within(dialog).getByRole("button", { name: "이 폴더 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    expect(f.scanned).toEqual([{ directory: "2024" }]);

    expect(await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개")).toBeTruthy();
    const chips = within(dialog).getByLabelText("스캔 요약");
    expect(within(chips).getByText("새 파일 2")).toBeTruthy();
    expect(within(chips).getByText("변경된 문서 1")).toBeTruthy();
    expect(within(chips).getByText("변경 없음 1")).toBeTruthy();
    expect(within(chips).getByText("잠김 1")).toBeTruthy();
    expect(within(dialog).getByText("건너뜀: 임시 파일 1 · 지원하지 않는 파일 2")).toBeTruthy();
    expect(within(dialog).queryByRole("table", { name: "원본 파일 목록" })).toBeNull();

    // 대상 수는 targeted(3) ↔ targeted + 변경 없음 + 잠김(5)
    expect(startButton(dialog).textContent).toBe("3개 등록 시작");
    const again = within(dialog).getByLabelText("변경 없는 문서·잠긴 문서도 다시 읽기");
    await user.click(again);
    expect(startButton(dialog).textContent).toBe("5개 등록 시작");
    await user.click(again);
    expect(startButton(dialog).textContent).toBe("3개 등록 시작");
    expect(f.scanned).toHaveLength(1);
    expect(dialog.textContent).not.toMatch(UUID_RE);

    await user.click(startButton(dialog));
    await f.waitForApi(/^\/documents\/register-directory\?wait=10/, "POST");
    expect(f.registeredDirectory).toHaveLength(1);
    expect(f.registeredDirectory[0].body).toEqual({ directory: "2024", provider: "local-xlsx", include_unchanged: false });

    const results = await within(dialog).findByRole("table", { name: "등록 결과" });
    expect(within(results).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "등록", "자동 적용", "상태", "실패 사유"]);
    expect(within(dialog).getByText("3개 중 2개 등록 · 1개 변경 없음 · 1개 실패 · 1개 잠김")).toBeTruthy();
    const rows = within(results).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("공정데이터_2024_05.xlsx");
    expect(within(rows[0]).getByText("완료", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[0]).getByText("정상", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[2]).getByText("실패", { selector: ".app-chip" })).toBeTruthy();
    expect(rows[2].textContent).toContain("파일을 열 수 없습니다");
    expect(within(dialog).queryByText(/앞 500개만 표시/)).toBeNull();
    expect(dialog.textContent).not.toMatch(UUID_RE);
    expect(await screen.findByText("2개 문서 등록 · 1개 실패")).toBeTruthy();
    // 등록 뒤 문서 목록을 다시 읽는다
    await f.waitForApi(/^\/documents\?/, "GET", 2);
  });

  it("등록 대상이 없으면 시작 버튼이 비활성이고 안내를 보여주며, 다시 읽기를 켜면 대상이 생긴다", async () => {
    const { f, user, dialog } = await openRegister();
    await user.click(within(dialog).getByRole("button", { name: "원본 폴더 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan$/);
    expect(await within(dialog).findByText("원본 폴더 아래 파일 6개 · 하위 폴더 1개")).toBeTruthy();
    expect(startButton(dialog).textContent).toBe("0개 등록 시작");
    expect(startButton(dialog).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByText(/등록할 새 파일이나 변경된 문서가 없습니다\./)).toBeTruthy();
    await user.click(within(dialog).getByLabelText("변경 없는 문서·잠긴 문서도 다시 읽기"));
    expect(startButton(dialog).textContent).toBe("6개 등록 시작");
    expect(startButton(dialog).hasAttribute("disabled")).toBe(false);
    expect(within(dialog).queryByText(/등록할 새 파일이나 변경된 문서가 없습니다\./)).toBeNull();
    expect(dialog.textContent).not.toMatch(UUID_RE);
  });

  it("413 DIRECTORY_LIMIT은 서버 문구를 그대로 보여주고 '파일 고르기로 돌아가기'가 된다", async () => {
    const f = documentsFixture();
    const message = "폴더 안 파일이 10,000개를 넘습니다. 하위 폴더를 나누어 등록하세요.";
    f.overrides.set("GET /sources/scan", () => reply(413, errorBody("DIRECTORY_LIMIT", message)));
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ 문서 등록" }));
    const dialog = await screen.findByRole("dialog", { name: "문서 등록" });
    await within(dialog).findByRole("table", { name: "원본 파일 목록" });
    await user.click(within(dialog).getByRole("button", { name: "원본 폴더 전체 등록" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain(message);
    expect(startButton(dialog).hasAttribute("disabled")).toBe(true);
    expect(f.registeredDirectory).toHaveLength(0);
    await user.click(footer(dialog).getByRole("button", { name: "파일 고르기로 돌아가기" }));
    expect(await within(dialog).findByRole("table", { name: "원본 파일 목록" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "원본 폴더 전체 등록" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(UUID_RE);
  });

  it("폴더 행의 '2024 전체 등록'은 폴더를 열지 않고 같은 미리보기를 연다", async () => {
    const { f, user, dialog } = await openRegister();
    await user.click(within(dialog).getByRole("button", { name: "2024 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    expect(await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개")).toBeTruthy();
    expect(startButton(dialog).textContent).toBe("3개 등록 시작");
    // 행 클릭(폴더 이동)은 일어나지 않는다
    expect(f.callsTo(/^\/sources\?directory=2024/)).toHaveLength(0);
    await user.click(footer(dialog).getByRole("button", { name: "파일 고르기로 돌아가기" }));
    expect(within(dialog).getByRole("button", { name: "원본 폴더 전체 등록" })).toBeTruthy();
  });

  it("10초 뒤에도 진행 중이면 폴더 일괄 등록 진행률을 보여주고, 닫아도 JobBar에서 이어진다", async () => {
    const { f, user, dialog } = await openRegister();
    const running = job({ kind: "register", state: "running", completed: 1, total: 3, result: null, finished_at: null, label: "2024 폴더 일괄 등록" });
    f.overrides.set("POST /documents/register-directory", () => {
      f.state.running.push(running);
      return running;
    });
    await user.click(within(dialog).getByRole("button", { name: "2024 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개");
    await user.click(startButton(dialog));
    await within(dialog).findByText(/폴더 일괄 등록 진행 중 \(1\/3\)/);
    expect(within(dialog).queryByRole("table", { name: "등록 결과" })).toBeNull();
    expect(footer(dialog).queryByRole("button", { name: "파일 고르기로 돌아가기" })).toBeNull();
    await user.click(footer(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("진행 중 작업 1");
  });

  it("화면을 바꿔도 초점이 대화상자 안에 남아 Esc로 닫을 수 있다", async () => {
    const { f, user, dialog } = await openRegister();
    await user.click(within(dialog).getByRole("button", { name: "2024 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개");
    // 누른 버튼(파일 목록)이 사라져도 초점은 대화상자 안에 남는다 — body로 떨어지면 Esc가 죽고 Tab이 밖으로 샌다.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.click(footer(dialog).getByRole("button", { name: "파일 고르기로 돌아가기" }));
    await within(dialog).findByRole("table", { name: "원본 파일 목록" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("대화상자를 닫은 뒤 작업이 끝나면 문서 목록을 다시 읽는다", async () => {
    const { f, user, dialog } = await openRegister();
    const running = job({ kind: "register", state: "running", completed: 1, total: 3, result: null, finished_at: null, label: "2024 폴더 일괄 등록" });
    f.overrides.set("POST /documents/register-directory", () => {
      f.state.running.push(running);
      return running;
    });
    await user.click(within(dialog).getByRole("button", { name: "2024 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개");
    await user.click(startButton(dialog));
    await within(dialog).findByText(/폴더 일괄 등록 진행 중/);
    await user.click(footer(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await screen.findByText("진행 중 작업 1");
    const before = f.callsTo(/^\/documents\?/).length;
    f.state.running.length = 0; // 서버에서 작업이 끝났다
    await waitFor(() => expect(screen.queryByText("진행 중 작업 1")).toBeNull(), { timeout: 10000 });
    // JobBar가 종료를 보면 캐시를 비우고 알리므로 목록이 다시 읽힌다(대화상자는 이미 닫혔다).
    await waitFor(() => expect(f.callsTo(/^\/documents\?/).length).toBeGreaterThan(before), { timeout: 10000 });
  });

  it("결과가 500행을 넘으면 잘렸다는 안내를 함께 보여준다", async () => {
    const { f, user, dialog } = await openRegister();
    f.overrides.set("POST /documents/register-directory", () =>
      job({ kind: "register", label: "2024 폴더 일괄 등록", result: { ...registerDirectoryResult("2024"), truncated: true } as unknown as Record<string, unknown> }),
    );
    await user.click(within(dialog).getByRole("button", { name: "2024 전체 등록" }));
    await f.waitForApi(/^\/sources\/scan\?directory=2024/);
    await within(dialog).findByText("2024/ 아래 파일 5개 · 하위 폴더 1개");
    await user.click(startButton(dialog));
    await f.waitForApi(/^\/documents\/register-directory\?wait=10/, "POST");
    expect(await within(dialog).findByText("앞 500개만 표시 — 나머지는 문서 화면에서 확인하세요")).toBeTruthy();
    expect(within(dialog).getByRole("table", { name: "등록 결과" })).toBeTruthy();
    expect(dialog.textContent).not.toMatch(UUID_RE);
    // '추가 등록'은 파일 고르기 초기 상태로 돌아간다
    await user.click(footer(dialog).getByRole("button", { name: "추가 등록" }));
    expect(await within(dialog).findByRole("table", { name: "원본 파일 목록" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "원본 폴더 전체 등록" })).toBeTruthy();
  });
});

// §4.13 문서 삭제 — 되돌릴 수 없는 일이라 무엇을 지우는지 확인 대화상자가 이름으로 말하고, 원본 파일 삭제는 기본 해제다.
describe("문서 삭제(§4.13)", () => {
  const deleteDialog = () => screen.findByRole("dialog", { name: "문서 삭제" });
  const confirmButton = (dialog: HTMLElement) => footer(dialog).getByRole("button", { name: "삭제" });

  // 목록에서 두 문서를 고르고 선택 바의 `삭제`를 눌러 확인 대화상자까지 연다.
  async function selectTwo() {
    const f = documentsFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "공정데이터_2024_01.xlsx 선택" }));
    await user.click(screen.getByRole("checkbox", { name: "공정데이터_2024_02.xlsx 선택" }));
    await user.click(within(screen.getByRole("region", { name: "선택한 문서" })).getByRole("button", { name: "삭제" }));
    return { f, user, dialog: await deleteDialog() };
  }

  it("선택 바의 `삭제`는 문서 수·이름과 기본 해제된 원본 체크박스를 보이고, 확인하면 POST /documents/delete를 부른다", async () => {
    const { f, user, dialog } = await selectTwo();
    expect(dialog.textContent).toContain("문서 2개를 지웁니다. 각 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.");
    const listed = within(dialog).getByRole("list", { name: "지울 문서" });
    expect(within(listed).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["공정데이터_2024_01.xlsx", "공정데이터_2024_02.xlsx"]);
    const purge = within(dialog).getByRole("checkbox", { name: /원본 파일도 함께 지우기/ });
    expect((purge as HTMLInputElement).checked).toBe(false);
    expect(dialog.textContent).toContain("체크하지 않으면 원본 파일은 그대로 남고, 다시 등록하면 같은 문서가 만들어집니다.");
    expect(footer(dialog).getByRole("button", { name: "취소" })).toBeTruthy();

    await user.click(confirmButton(dialog));
    await f.waitForApi(/^\/documents\/delete\?wait=10/, "POST");
    expect(f.deleted).toHaveLength(1);
    expect(f.deleted[0]).toMatchObject({ ids: [f.ids.document(1), f.ids.document(2)], purge: false, wait: "10" });
    expect(f.callsTo(/^\/documents\/delete/, "POST")[0].body).toEqual({
      document_ids: [f.ids.document(1), f.ids.document(2)],
      purge_source: false,
    });
    // 실패가 없으면 대화상자는 닫히고 결과는 토스트로 요약한다(대표 문서를 지웠으므로 프로파일 초안 줄이 붙는다).
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 삭제" })).toBeNull());
    const toast = await screen.findByText(/문서 2개를 지웠습니다\./);
    expect(toast.textContent).toContain("파싱 프로파일 1개가 초안으로 내려갔습니다 — 대표 문서를 다시 지정해 승인하세요.");
    expect(toast.textContent).not.toContain("원본 파일");
    // 초안으로 내려간 프로파일을 바로 볼 수 있게 목록으로 가는 길을 붙인다.
    expect(screen.getByRole("button", { name: "파싱 프로파일 열기" })).toBeTruthy();
    // 목록을 다시 읽고 선택을 비운다.
    await waitFor(() => expect(screen.queryByText("2개 선택")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "공정데이터_2024_01.xlsx 선택" })).toBeNull());
  });

  it("원본 파일도 함께 지우기를 켜면 purge_source=true로 보내고 결과에 원본 삭제 수를 알린다", async () => {
    const { f, user, dialog } = await selectTwo();
    await user.click(within(dialog).getByRole("checkbox", { name: /원본 파일도 함께 지우기/ }));
    await user.click(confirmButton(dialog));
    await f.waitForApi(/^\/documents\/delete\?wait=10/, "POST");
    expect(f.callsTo(/^\/documents\/delete/, "POST")[0].body.purge_source).toBe(true);
    const toast = await screen.findByText(/문서 2개를 지웠습니다\./);
    expect(toast.textContent).toContain("원본 파일 2개도 지웠습니다.");
  });

  it("상세 드로어의 `삭제`는 같은 대화상자를 단건 문구로 열고 DELETE /documents/{id}를 부른다", async () => {
    const f = documentsFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(2)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    const dialog = await deleteDialog();
    expect(dialog.textContent).toContain("'공정데이터_2024_02.xlsx'을(를) 지웁니다. 이 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.");
    // 단건에는 이름 목록을 따로 두지 않는다(문구가 이미 이름을 말한다).
    expect(within(dialog).queryByRole("list", { name: "지울 문서" })).toBeNull();
    // Escape는 확인 대화상자만 닫는다(뒤의 상세 드로어는 그대로 열려 있다).
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 삭제" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "문서 상세" })).toBeTruthy();
    await user.click(within(drawer).getByRole("button", { name: "삭제" }));
    const reopened = await deleteDialog();
    await user.click(confirmButton(reopened));
    await f.waitForApi(new RegExp(`^/documents/${f.ids.document(2)}\\?purge_source=false`), "DELETE");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 드로어도 함께 닫힌다.
    expect(route().get("document")).toBeNull();
    expect(await screen.findByText(/문서 1개를 지웠습니다\./)).toBeTruthy();
  });

  it("진행 중 작업(DOCUMENT_BUSY)은 대화상자에 그대로 보이고 `삭제`를 잠그지 않는다", async () => {
    const { f, user, dialog } = await selectTwo();
    let busy = true;
    f.overrides.set("POST /documents/delete", (call) => {
      if (busy) return reply(409, errorBody("DOCUMENT_BUSY", "이 문서에 진행 중인 작업이 있습니다. 끝난 뒤 다시 지우세요."));
      const result = documentDeleteResult(f.state.documents, call.body?.document_ids || [], false);
      return job({ kind: "delete", target_kind: "workspace", target_id: null, label: "문서 2개 삭제", result: result as unknown as Record<string, unknown> });
    });
    await user.click(confirmButton(dialog));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("이 문서에 진행 중인 작업이 있습니다. 끝난 뒤 다시 지우세요.");
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(false);
    // 작업이 끝나면 같은 대화상자에서 다시 누를 수 있다(두 문서 모두 그대로 남아 있다).
    busy = false;
    await user.click(confirmButton(dialog));
    await f.waitForApi(/^\/documents\/delete/, "POST", 2);
    expect(f.callsTo(/^\/documents\/delete/, "POST")[1].body.document_ids).toEqual([f.ids.document(1), f.ids.document(2)]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 삭제" })).toBeNull());
  });

  it("한 건이 실패하면 대화상자를 열어 둔 채 무엇이 실패했는지 보이고, 다시 누르면 남은 문서만 보낸다", async () => {
    const { f, user, dialog } = await selectTwo();
    let attempt = 0;
    f.overrides.set("POST /documents/delete", (call) => {
      attempt++;
      const requested: string[] = call.body?.document_ids || [];
      if (attempt === 1)
        return job({
          kind: "delete",
          target_kind: "workspace",
          target_id: null,
          label: "문서 2개 삭제",
          result: {
            documents: [
              { document_id: f.ids.document(1), document_name: "공정데이터_2024_01.xlsx", source_ref: "2024/공정데이터_2024_01.xlsx", deleted: { snapshots: 1, applications: 1, mappings: 2, runs: 1, values: 40 }, source_removed: false },
              { document_id: f.ids.document(2), document_name: "공정데이터_2024_02.xlsx", source_ref: null, deleted: { snapshots: 0, applications: 0, mappings: 0, runs: 0, values: 0 }, source_removed: false, error: { code: "DOCUMENT_BUSY", message: "이 문서에 진행 중인 작업이 있습니다. 끝난 뒤 다시 지우세요." } },
            ],
            profiles_reset: [],
            summary: { requested: 2, deleted: 1, failed: 1 },
          } as unknown as Record<string, unknown>,
        });
      return job({
        kind: "delete",
        target_kind: "workspace",
        target_id: null,
        label: "문서 1개 삭제",
        result: {
          documents: requested.map((id) => ({ document_id: id, document_name: "공정데이터_2024_02.xlsx", source_ref: null, deleted: { snapshots: 1, applications: 1, mappings: 1, runs: 1, values: 3 }, source_removed: false })),
          profiles_reset: [],
          summary: { requested: requested.length, deleted: requested.length, failed: 0 },
        } as unknown as Record<string, unknown>,
      });
    });
    await user.click(confirmButton(dialog));
    const result = await within(dialog).findByRole("status", { name: "삭제 결과" });
    expect(result.textContent).toContain("문서 1개를 지웠습니다.");
    expect(result.textContent).toContain("실패 1건");
    expect(within(dialog).getByRole("list", { name: "지우지 못한 문서" }).textContent).toContain("이 문서에 진행 중인 작업이 있습니다.");
    // 남은 한 건만 다시 보낸다 — 이미 지운 문서를 또 보내지 않는다(한 건이므로 단건 경로로 간다).
    expect(dialog.textContent).toContain("'공정데이터_2024_02.xlsx'을(를) 지웁니다.");
    await user.click(confirmButton(dialog));
    await f.waitForApi(new RegExp(`^/documents/${f.ids.document(2)}\\?purge_source=false`), "DELETE");
    expect(f.callsTo(/^\/documents\/delete/, "POST")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 삭제" })).toBeNull());
  });

  it("원본 파일을 지우지 못하면 문서는 지워진 채로 대화상자에 그 사유를 남긴다", async () => {
    const f = documentsFixture();
    // 보안 문서(provider가 local-xlsx가 아니다)는 원본을 지울 수 없다.
    f.renderApp(`?screen=documents&document=${f.ids.document(7)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    const dialog = await deleteDialog();
    await user.click(within(dialog).getByRole("checkbox", { name: /원본 파일도 함께 지우기/ }));
    await user.click(confirmButton(dialog));
    const result = await within(dialog).findByRole("status", { name: "삭제 결과" });
    expect(result.textContent).toContain("문서 1개를 지웠습니다.");
    expect(result.textContent).toContain("원본 파일 1개는 지우지 못했습니다.");
    expect(within(dialog).getByRole("list", { name: "지우지 못한 원본 파일" }).textContent).toContain("로컬 원본이 아니어서 원본 파일을 지울 수 없습니다.");
    // 문서는 지워졌으므로 더 지울 것이 없다.
    expect((confirmButton(dialog) as HTMLButtonElement).disabled).toBe(true);
  });

  // 되돌릴 수 없는 삭제가 도는 중에는 어느 길로도 대화상자가 닫히지 않는다 — 닫히면 사용자는 취소했다고 믿는데
  // 요청은 끝까지 가고, 부분 실패 내역을 볼 곳이 사라진다(§7).
  it("삭제가 도는 중에는 Escape·배경 클릭·×가 대화상자를 닫지 않는다", async () => {
    const { f, user, dialog } = await selectTwo();
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    f.overrides.set("POST /documents/delete", async (call) => {
      await pending;
      const result = documentDeleteResult(f.state.documents, call.body?.document_ids || [], false);
      return job({ kind: "delete", target_kind: "workspace", target_id: null, label: "문서 2개 삭제", result: result as unknown as Record<string, unknown> });
    });
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(footer(dialog).getByRole("button", { name: "지우는 중…" })).toBeTruthy());
    // 취소 버튼이 잠긴 것과 같은 뜻이어야 한다.
    expect((footer(dialog).getByRole("button", { name: "취소" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "닫기" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "문서 삭제" })).toBeTruthy();
    const backdrops = document.querySelectorAll(".app-modal-backdrop");
    fireEvent.click(backdrops[backdrops.length - 1]);
    expect(screen.getByRole("dialog", { name: "문서 삭제" })).toBeTruthy();
    release(null);
    // 요청이 끝나면 그때 닫힌다(취소한 줄 알았던 삭제가 몰래 끝나 있는 일이 없다).
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "문서 삭제" })).toBeNull());
    expect(await screen.findByText(/문서 2개를 지웠습니다\./)).toBeTruthy();
  });

  it("검색·필터·정렬이 바뀌면 선택을 비운다 — 화면에 없는 문서가 삭제에 딸려 가지 않는다", async () => {
    const f = documentsFixture();
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "공정데이터_2024_01.xlsx 선택" }));
    expect(await screen.findByText("1개 선택")).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("상태"), "review");
    await waitFor(() => expect(screen.queryByText("1개 선택")).toBeNull());
    // 정렬도 마찬가지다(필터를 바꾼 뒤 보이는 첫 행을 고른다).
    const visible = screen.getAllByRole("checkbox").filter((c) => c.getAttribute("aria-label") !== "전체 선택");
    await user.click(visible[0]);
    expect(await screen.findByText("1개 선택")).toBeTruthy();
    await user.click(within(header(/문서명/)).getByRole("button"));
    await waitFor(() => expect(screen.queryByText("1개 선택")).toBeNull());
    expect(f.callsTo(/^\/documents\?/).length).toBeGreaterThan(1);
  });

  it("이름 10개를 넘으면 `외 N개`와 함께 전체 목록을 펼쳐 확인할 수 있다", async () => {
    const f = documentsFixture();
    const base = f.state.documents[0];
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...base,
      document_id: f.ids.document(100 + i),
      document_name: `대량문서_${String(i + 1).padStart(2, "0")}.xlsx`,
      profiles: [],
      schemas: [],
    }));
    f.overrides.set("GET /documents", () => page(many));
    f.renderApp("?screen=documents");
    await documentsTable();
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "전체 선택" }));
    expect(await screen.findByText("12개 선택")).toBeTruthy();
    await user.click(within(screen.getByRole("region", { name: "선택한 문서" })).getByRole("button", { name: "삭제" }));
    const dialog = await deleteDialog();
    expect(within(within(dialog).getByRole("list", { name: "지울 문서" })).getAllByRole("listitem")).toHaveLength(11);
    expect(dialog.textContent).toContain("외 2개");
    // 감추지 않는다 — 200건까지도 이름으로 확인할 수 있어야 한다.
    const all = within(dialog).getByRole("list", { name: "지울 문서 전체" });
    expect(within(all).getAllByRole("listitem").map((li) => li.textContent)).toEqual(many.map((d) => d.document_name));
    expect(within(dialog).getByText("지울 문서 12개 모두 보기")).toBeTruthy();
  });

  it("대표 문서를 지우기 전에 프로파일이 초안으로 내려간다고 알린다", async () => {
    const f = documentsFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    const dialog = await deleteDialog();
    expect(dialog.textContent).toContain("대표 문서입니다 — 파싱 프로파일 '공정데이터_A양식'");
    expect(dialog.textContent).toContain("새 문서에 자동 적용되지 않습니다.");
  });

  it("대표 문서가 아니면 초안 경고를 붙이지 않는다", async () => {
    const f = documentsFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(2)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    expect((await deleteDialog()).textContent).not.toContain("대표 문서입니다");
  });

  it("확인 대화상자가 열린 동안 뒤의 상세 드로어는 조작할 수 없다(inert)", async () => {
    const f = documentsFixture();
    f.renderApp(`?screen=documents&document=${f.ids.document(2)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    expect(drawer.hasAttribute("inert")).toBe(false);
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    await deleteDialog();
    // 곧 지울 문서를 빌드 대기열에 넣는 모순 상태를 막는다.
    expect(drawer.hasAttribute("inert")).toBe(true);
  });

  it("렌더 캐시를 지우지 못하면 문서는 지워진 채로 그 사실을 남긴다", async () => {
    const f = documentsFixture();
    f.overrides.set(`DELETE /documents/${f.ids.document(2)}`, () => ({
      documents: [
        {
          document_id: f.ids.document(2),
          document_name: "공정데이터_2024_02.xlsx",
          source_ref: "2024/공정데이터_2024_02.xlsx",
          deleted: { snapshots: 1, applications: 1, mappings: 2, runs: 1, values: 40 },
          source_removed: false,
          render_error: { code: "RENDER_UNAVAILABLE", message: "렌더 서버에 연결할 수 없습니다." },
        },
      ],
      profiles_reset: [],
      summary: { requested: 1, deleted: 1, failed: 0 },
    }));
    f.renderApp(`?screen=documents&document=${f.ids.document(2)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    const user = userEvent.setup();
    await user.click(await within(drawer).findByRole("button", { name: "삭제" }));
    const dialog = await deleteDialog();
    await user.click(confirmButton(dialog));
    const result = await within(dialog).findByRole("status", { name: "삭제 결과" });
    expect(result.textContent).toContain("문서 1개의 렌더 캐시를 지우지 못했습니다 — 서버를 다시 시작하면 회수합니다.");
    expect(within(dialog).getByRole("list", { name: "렌더 캐시를 지우지 못한 문서" }).textContent).toContain("렌더 서버에 연결할 수 없습니다.");
  });

  it("지워진 문서를 가리키는 옛 작업 내역 행으로 들어가면 404 대신 한 줄로 알린다", async () => {
    const f = appFixture();
    f.overrides.set(`GET /documents/${f.ids.document(1)}`, () => reply(404, errorBody("UNKNOWN_DOCUMENT", "문서를 찾을 수 없습니다.")));
    f.renderApp(`?screen=documents&document=${f.ids.document(1)}`);
    const drawer = await screen.findByRole("dialog", { name: "문서 상세" });
    expect(await within(drawer).findByText("이 문서는 삭제되었습니다.")).toBeTruthy();
    expect(within(drawer).queryByRole("alert")).toBeNull();
  });
});
