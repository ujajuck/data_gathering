import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SHA_RE, UUID_RE, ids, job, page } from "./fixture";
import { FAILED_APPLICATION, GROUP_KEYS, REVIEW_APPLICATION, RUNNING_JOB, jobsFixture } from "./jobs-fixture";

const route = () => new URLSearchParams(location.search);
const rowOf = (text: string | RegExp) => {
  const cell = screen.getByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error("row not found");
  return row;
};

describe("작업 내역 화면", () => {
  it("요약 카드 5개·렌더 서버 상태 한 줄·작업 목록을 보여주고 진입 호출은 3개 이하다", async () => {
    const f = jobsFixture();
    const { container } = f.renderApp("?screen=jobs");
    const summary = await screen.findByRole("group", { name: "검수 큐 요약" });
    await screen.findByRole("table", { name: "작업 목록" });
    await screen.findByRole("table", { name: "신규 양식 묶음" });
    const cards = within(summary).getAllByRole("button");
    expect(cards.map((c) => c.textContent)).toEqual(["3신규 양식", "5매핑 검수", "2파싱 실패", "1변경 감지", "0충돌"]);
    // 카드가 없는 URL이면 첫 번째로 비어 있지 않은 큐가 선택된다.
    expect(cards[0].getAttribute("aria-pressed")).toBe("true");
    const status = screen.getByRole("status", { name: "렌더 서버 상태" });
    expect(status.textContent).toContain("내장");
    expect(status.textContent).toContain("대기 0건");
    expect(status.textContent).toContain("렌더링 중 0건");
    // 진입 호출: /queues · /queues/{kind} · /jobs (/status는 쉘과 캐시 공유 → 1회)
    const entry = f.calls.filter((c) => c.method === "GET" && !c.path.startsWith("/status") && c.url.searchParams.get("state") !== "running");
    expect(entry.map((c) => c.path)).toEqual(["/queues", "/jobs", "/queues/unmatched"]);
    expect(f.callsTo(/^\/status/)).toHaveLength(1);
    expect(entry.find((c) => c.path === "/jobs")?.url.searchParams.get("limit")).toBe("50");
    // 작업 표: 종류 한글 · 대상(label) · 상태 칩 · 결과/오류
    const table = screen.getByRole("table", { name: "작업 목록" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["종류", "대상", "상태", "시작", "종료", "결과/오류"]);
    expect(within(table).getByText("묶음 처리")).toBeTruthy();
    expect(within(screen.getByLabelText("종류")).getAllByRole("option").map((o) => o.textContent)).toEqual(["전체", "등록", "추출", "재파싱", "빌드", "테스트", "묶음 처리", "삭제"]);
    expect(rowOf("전체 승인 · 공정데이터_A양식 v2").textContent).toContain("처리 4건");
    expect(rowOf("빌드 · 문서 3개").textContent).toContain("출력 Header가 비어 있습니다.");
    expect(within(rowOf("공정데이터_B양식 v1 · 재파싱")).getByText("진행 중 2/5", { selector: ".app-chip" })).toBeTruthy();
    // ID 비노출(§7)
    expect(container.textContent).not.toMatch(UUID_RE);
    expect(container.textContent).not.toMatch(SHA_RE);
  });

  it("카드 클릭은 ?queue=를 바꾸고 묶음 행 `대상 · 원인 · 영향 · 처리`를 보여준다; 검수 열기는 ?review=로 간다", async () => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs");
    await screen.findByRole("table", { name: "신규 양식 묶음" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /매핑 검수/ }));
    expect(route().get("queue")).toBe("review");
    const table = await screen.findByRole("table", { name: "매핑 검수 묶음" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["펼치기", "대상", "원인", "영향", "처리"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("공정데이터_A양식 v2");
    expect(rows[0].textContent).toContain("헤드 매핑 2건이 검수 대기 중입니다");
    expect(rows[0].textContent).toContain("문서 3개");
    expect(within(rows[0]).getByText("temperature", { selector: ".app-chip" })).toBeTruthy();
    // approve_all이 actions[]에 없는 묶음은 전체 승인 비활성
    expect(within(rows[0]).getByRole("button", { name: "전체 승인" }).hasAttribute("disabled")).toBe(false);
    expect(within(rows[1]).getByRole("button", { name: "전체 승인" }).hasAttribute("disabled")).toBe(true);
    await user.click(within(rows[0]).getByRole("button", { name: "검수 열기" }));
    expect(route().get("review")).toBe(REVIEW_APPLICATION);
    expect(route().get("queue")).toBe("review");
  });

  it("전체 승인은 POST .../actions?wait=10 {approve_all, extract:true}를 보내고 즉시 행·요약 수를 갱신한 뒤 토스트를 띄운다", async () => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs&queue=review");
    const table = await screen.findByRole("table", { name: "매핑 검수 묶음" });
    const user = userEvent.setup();
    const first = within(table).getAllByRole("row")[1];
    await user.click(within(first).getByRole("button", { name: "전체 승인" }));
    // 낙관적 갱신: 행이 빠지고 요약 카드가 5 → 2
    expect(within(screen.getByRole("table", { name: "매핑 검수 묶음" })).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("button", { name: /매핑 검수/ }).textContent).toBe("2매핑 검수");
    await f.waitForApi(/^\/queues\/review\/groups\/[^/]+\/actions\?wait=10$/, "POST");
    expect(f.actions).toEqual([{ kind: "review", groupKey: GROUP_KEYS.reviewA, body: { action: "approve_all", extract: true } }]);
    const toast = await screen.findByText(/처리 2건 · 건너뜀 1건/);
    expect(toast.textContent).toContain("전체 승인");
    // 서버 상태와 다시 맞춘 뒤에도 행은 돌아오지 않는다
    await f.waitForApi(/^\/queues$/, "GET", 2);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "매핑 검수 묶음" })).getAllByRole("row")).toHaveLength(2));
    expect(document.body.textContent).not.toMatch(UUID_RE);
  });

  it("처리가 실패하면 행과 요약 수를 되돌리고 오류 토스트를 띄운다", async () => {
    const f = jobsFixture({ actionFails: true });
    f.renderApp("?screen=jobs&queue=review");
    const table = await screen.findByRole("table", { name: "매핑 검수 묶음" });
    const user = userEvent.setup();
    await user.click(within(within(table).getAllByRole("row")[1]).getByRole("button", { name: "전체 승인" }));
    await screen.findByText(/이 묶음에는 허용되지 않는 처리입니다/);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "매핑 검수 묶음" })).getAllByRole("row")).toHaveLength(3));
    expect(screen.getByRole("button", { name: /매핑 검수/ }).textContent).toBe("5매핑 검수");
  });

  it("프로파일 지정은 승인된 프로파일 목록에서 고른 뒤 {assign_profile, profile_id}를 보낸다", async () => {
    const f = jobsFixture();
    const { container } = f.renderApp("?screen=jobs&queue=unmatched");
    await screen.findByRole("table", { name: "신규 양식 묶음" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "프로파일 지정" }));
    const dialog = await screen.findByRole("dialog", { name: "묶음 처리" });
    expect(container.querySelector(".app-summary")?.closest("[inert]")).toBeTruthy();
    await f.waitForApi(/^\/profiles\?status=approved/);
    const select = await within(dialog).findByLabelText("파싱 프로파일");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["공정데이터_A양식 v2", "공정데이터_B양식 v1"]);
    await user.selectOptions(select, ids.profile2);
    await user.click(within(dialog).getByRole("button", { name: "프로파일 지정" }));
    await f.waitForApi(/^\/queues\/unmatched\/groups\/[^/]+\/actions\?wait=10$/, "POST");
    expect(f.actions[0].body).toEqual({ action: "assign_profile", profile_id: ids.profile2 });
    expect(f.actions[0].groupKey).toBe(GROUP_KEYS.unmatched);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(container.textContent).not.toMatch(SHA_RE);
  });

  it("프로파일 만들기는 ?screen=profiles&import=1로, 재파싱은 방식(mode)을 골라 보낸다", async () => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs&queue=failed");
    await screen.findByRole("table", { name: "파싱 실패 묶음" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "재파싱" }));
    const dialog = await screen.findByRole("dialog", { name: "묶음 처리" });
    await user.selectOptions(within(dialog).getByLabelText("재파싱 방식"), "fill");
    await user.click(within(dialog).getByRole("button", { name: "재파싱" }));
    await f.waitForApi(/^\/queues\/failed\/groups\/SELECTOR_NOT_FOUND\/actions\?wait=10$/, "POST");
    expect(f.actions[0].body).toEqual({ action: "reparse", mode: "fill" });

    await user.click(screen.getByRole("button", { name: /신규 양식/ }));
    await screen.findByRole("table", { name: "신규 양식 묶음" });
    await user.click(screen.getByRole("button", { name: "프로파일 만들기" }));
    expect(route().get("screen")).toBe("profiles");
    expect(route().get("import")).toBe("1");
    // 대화상자에서 테스트하지 않으므로 snapshot은 싣지 않는다.
    expect(route().get("snapshot")).toBeNull();
  });

  it("묶음 행을 펼치면 멤버(문서명 · Snapshot · 상태 · 원본 보기)를 한 번만 불러온다", async () => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs&queue=review");
    await screen.findByRole("table", { name: "매핑 검수 묶음" });
    expect(f.callsTo(/members/)).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "공정데이터_A양식 v2 멤버 펼치기" }));
    const members = await screen.findByRole("table", { name: "공정데이터_A양식 v2 멤버" });
    expect(f.callsTo(/^\/queues\/review\/groups\/[^/]+\/members\?/)).toHaveLength(1);
    expect(within(members).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["문서명", "Snapshot", "상태", "원본 보기"]);
    const rows = within(members).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("공정데이터_2024_02.xlsx");
    expect(rows[0].textContent).toContain("2026-09-14");
    expect(within(rows[0]).getByText("검수 필요", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[2]).getByText("재추출 필요", { selector: ".app-chip" })).toBeTruthy();
    expect(within(rows[2]).getByRole("button", { name: "원본 보기" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "공정데이터_A양식 v2 멤버 접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(members.textContent).not.toMatch(UUID_RE);
    await user.click(within(rows[0]).getByRole("button", { name: "원본 보기" }));
    expect(route().get("review")).toBe(REVIEW_APPLICATION);
  });

  it.each([
    ["application", "손상파일_2024.xlsx · 추출", { review: FAILED_APPLICATION }],
    ["build", "빌드 · 문서 3개", { screen: "build" }],
    ["document", "보안문서_2024.xlsx · 등록", { screen: "documents", document: ids.document(7) }],
    ["profile", "공정데이터_A양식 v2 · 재파싱", { screen: "profiles", profile: ids.profile }],
  ])("실패 작업(target_kind=%s)의 이동 버튼은 대상 화면으로 간다", async (_kind, label, expected) => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs");
    await screen.findByRole("table", { name: "작업 목록" });
    const user = userEvent.setup();
    const row = rowOf(label);
    expect(within(row).getByText("실패", { selector: ".app-chip" })).toBeTruthy();
    await user.click(within(row).getByRole("button", { name: "이동" }));
    for (const [key, value] of Object.entries(expected)) expect(route().get(key)).toBe(value);
    // 성공·진행 중 행에는 이동 버튼이 없다
    expect(f.calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("폴더 일괄 등록 행의 결과 열은 잘린 documents 길이가 아니라 요약을 보여준다", async () => {
    const f = jobsFixture();
    f.overrides.set("GET /jobs", () =>
      page([
        job({
          kind: "register",
          label: "2024 폴더 일괄 등록",
          target_kind: "workspace",
          target_id: null,
          completed: 3000,
          total: 3000,
          // 목록 응답의 축약 결과(§6): documents 본문 대신 documents_count만 온다.
          result: {
            directory: "2024",
            truncated: true,
            documents_count: 500,
            summary: { found: 3200, targeted: 3000, registered: 2990, new: 3000, changed: 0, unchanged: 200, failed: 10, locked: 2, skipped: { temp: 0, unsupported: 0, symlink: 0 } },
          },
        }),
      ]),
    );
    f.renderApp("?screen=jobs");
    const table = await screen.findByRole("table", { name: "작업 목록" });
    const row = within(table).getAllByRole("row")[1];
    expect(row.textContent).toContain("등록");
    expect(row.textContent).toContain("3000개 중 2990개 등록 · 200개 변경 없음 · 10개 실패 · 2개 잠김");
    expect(row.textContent).not.toContain("문서 500개");
  });

  it("문서 삭제 행은 무엇을 지웠는지 요약하고 갈 곳이 없다(target_kind=workspace)", async () => {
    const f = jobsFixture();
    f.overrides.set("GET /jobs", () =>
      page([
        job({
          kind: "delete",
          label: "문서 2개 삭제",
          target_kind: "workspace",
          target_id: null,
          completed: 2,
          total: 2,
          result: {
            documents_count: 2,
            profiles_reset: [{ profile_id: ids.profile, profile_name: "공정데이터_A양식" }],
            summary: { requested: 2, deleted: 2, failed: 0 },
          },
        }),
      ]),
    );
    f.renderApp("?screen=jobs");
    const table = await screen.findByRole("table", { name: "작업 목록" });
    const row = within(table).getAllByRole("row")[1];
    expect(row.textContent).toContain("삭제");
    expect(row.textContent).toContain("문서 2개를 지웠습니다.");
    expect(row.textContent).toContain("파싱 프로파일 1개가 초안으로 내려갔습니다");
    expect(within(row).queryByRole("button", { name: "이동" })).toBeNull();
  });

  it("작업 목록 필터는 URL·API에 반영되고, 진행 중 작업은 취소할 수 있다(낙관적 갱신)", async () => {
    const f = jobsFixture();
    f.renderApp("?screen=jobs");
    await screen.findByRole("table", { name: "작업 목록" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("종류"), "reparse");
    expect(route().get("kind")).toBe("reparse");
    await f.waitForApi(/^\/jobs\?kind=reparse/);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "작업 목록" })).getAllByRole("row")).toHaveLength(3));
    await user.selectOptions(screen.getByLabelText("상태"), "running");
    await f.waitForApi(/^\/jobs\?state=running&kind=reparse/);
    await waitFor(() => expect(within(screen.getByRole("table", { name: "작업 목록" })).getAllByRole("row")).toHaveLength(2));
    const row = rowOf("공정데이터_B양식 v1 · 재파싱");
    expect(within(row).queryByRole("button", { name: "이동" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "취소" }));
    // 낙관적 갱신: 응답 전에 칩이 바뀌고 취소 버튼이 사라진다
    expect(within(row).getByText("취소됨", { selector: ".app-chip" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "취소" })).toBeNull();
    await f.waitForApi(new RegExp(`^/jobs/${RUNNING_JOB}/cancel$`), "POST");
    expect(f.cancelled).toEqual([RUNNING_JOB]);
    // 서버와 다시 맞추면 진행 중 필터에서 빠진다
    await waitFor(() => expect(screen.queryByText("공정데이터_B양식 v1 · 재파싱")).toBeNull());
  });

  it("실패한 작업이 없는 빈 상태와 큐가 빈 상태를 안내한다", async () => {
    const f = jobsFixture({ running: false });
    f.overrides.set("GET /jobs", () => ({ items: [], has_more: false, next_cursor: null }));
    f.renderApp("?screen=jobs&queue=conflict");
    expect((await screen.findByText("충돌 큐가 비어 있습니다.")).textContent).toBeTruthy();
    await screen.findByText("아직 작업이 없습니다.");
    expect(screen.queryByRole("table", { name: "작업 목록" })).toBeNull();
    expect(f.callsTo(/^\/jobs\?state=running/)).toHaveLength(0);
  });
});
