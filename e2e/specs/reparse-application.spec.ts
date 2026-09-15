// 문서 상세 · 한 건 재파싱 E2E(계약 §4.9 한 건 경로 · §7 문서 상세 적용 프로파일 행):
// 프로파일 정의를 고쳐 새 리비전을 저장한 뒤, 문서 상세의 적용 프로파일 행에서 `다시 파싱`을 눌러
// **그 문서 하나만** 현재 리비전으로 다시 맞추고 발행한다. 같은 버튼을 한 번 더 누르면 `이미 최신`으로 건너뛰고,
// 같은 프로파일을 쓰는 다른 문서는 옛 리비전 그대로다.
//
// 시나리오가 요구하는 준비(§4.8): 새 리비전으로 **발행**까지 가려면 매치 판정이 '동일'이어야 하고(§3.3),
// 그러려면 프로파일의 기준 서명이 현재 리비전에서 계산돼 있어야 한다 — 즉 대표 문서로 다시 승인해야 한다.
// 승인은 프로파일 **전체** 재파싱을 큐에 넣으므로(§4.8), 이 스펙은 그 작업을 돌기 전에 취소하고
// 다른 문서가 손타지 않았음을 확인한 뒤에야 한 건 경로를 본다(백엔드 테스트와 같은 방식).
//
// 두 test()는 같은 작업 공간을 순서대로 쓴다(fullyParallel=false): 1번이 v2를 저장하고 승인까지 끝내며,
// 2번이 그 상태에서 문서 상세의 버튼만 본다.
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, collectErrors, openDocument, openScreen, resetWorkspace, waitForJobs } from "./helpers";

const PROFILE_NAME = "공정데이터_A양식";
const PROFILE_V1 = "공정데이터_A양식 v1";
const PROFILE_V2 = "공정데이터_A양식 v2";
const REFERENCE = "공정데이터_2024_01.xlsx";
// 다시 파싱을 누를 문서와, 손대지 않았음을 확인할 문서. 둘 다 시드에서 자동 적용·발행된 같은 양식이다.
const TARGET = "공정데이터_2024_02.xlsx";
const WITNESS = "공정데이터_2024_03.xlsx";
const NEW_DESCRIPTION = "E2E에서 고친 정의 — LOT 표를 앞 6행만 읽는 리비전";
// 시드 정의의 LOT 표 값 영역 높이(60행)를 6행으로 좁힌다. 양식은 그대로라 매치는 '동일'이고,
// 열 규칙 7개의 값이 12개에서 6개로 줄어 '새 리비전이 이 문서에 닿았다'가 추출 결과 탭에서 그대로 보인다.
const SEED_ROWS = 60;
const NARROW_ROWS = 6;
// 값 46개 = 머리 정보 4개(제품명·레시피명·공정명·설비명) + 열 규칙 7개 × 6행.
const NARROWED_VALUES = 46;
// 값 영역을 좁힌 LOT 표 열 규칙 7개와, 정의가 그대로인 머리 정보 규칙 4개.
const COLUMN_RULES = ["duration", "lot", "measured_at", "pressure", "result_value", "temperature", "verdict"];
const SCALAR_RULES = ["equipment", "process_name", "product_name", "recipe_name"];

type ProfileRow = { profile_id: string; profile_name: string; current_rev: number; status: string };
type DocumentRow = { document_id: string; document_name: string };
type MappingRow = { rule_key: string; revision_no: number; status: string; origin: string; effective_spec: any };
type JobRow = { job_id: string; state: string; label: string | null; result: any; target_kind?: string; target_id?: string };

const detailOf = (page: Page) => page.getByRole("dialog", { name: "문서 상세" });

async function seededProfile(page: Page): Promise<ProfileRow> {
  const { status, json } = await api<{ items: ProfileRow[] }>(page, "GET", "/profiles?q=" + encodeURIComponent(PROFILE_NAME));
  expect(status).toBe(200);
  const row = json.items.find((p) => p.profile_name === PROFILE_NAME);
  expect(row, "시드 프로파일이 있어야 한다").toBeTruthy();
  return row!;
}

// 문서명 → {document_id, snapshot_id, application_id}. 시드 문서는 프로파일 적용 건이 하나뿐이다.
async function documentRefs(page: Page, name: string) {
  const list = await api<{ items: DocumentRow[] }>(page, "GET", "/documents?q=" + encodeURIComponent(name));
  const row = list.json.items.find((d) => d.document_name === name);
  expect(row, `문서 ${name}이(가) 있어야 한다`).toBeTruthy();
  const detail = await api<{ current_snapshot: { snapshot_id: string }; profiles: { application_id: string; rev: number }[] }>(page, "GET", `/documents/${row!.document_id}`);
  expect(detail.json.profiles).toHaveLength(1);
  return {
    document_id: row!.document_id,
    snapshot_id: detail.json.current_snapshot.snapshot_id,
    application_id: detail.json.profiles[0].application_id,
  };
}

// 적용 건의 규칙별 헤드(리비전 번호 + 컴파일된 값 영역 높이). '새 리비전이 이 문서에 닿았는가'의 눈이다.
async function heads(page: Page, applicationId: string): Promise<Map<string, { revision_no: number; rows: number; status: string; origin: string }>> {
  const { status, json } = await api<{ items: MappingRow[] }>(page, "GET", `/applications/${applicationId}/mappings`);
  expect(status).toBe(200);
  return new Map(
    json.items.map((m) => [
      m.rule_key,
      {
        revision_no: m.revision_no,
        rows: m.effective_spec?.selector?.value?.areas?.[0]?.relative?.rows,
        status: m.status,
        origin: m.origin,
      },
    ]),
  );
}

async function valueCount(page: Page, snapshotId: string, ruleKey?: string): Promise<number> {
  const path = `/snapshots/${snapshotId}/values` + (ruleKey ? `?rule_key=${ruleKey}` : "");
  const { json } = await api<{ items: unknown[] }>(page, "GET", path);
  return json.items.length;
}

async function waitForJob(page: Page, jobId: string): Promise<JobRow> {
  await expect
    .poll(async () => (await api<JobRow>(page, "GET", `/jobs/${jobId}`)).json.state, { timeout: 120_000, message: "작업이 끝나야 한다" })
    .toMatch(/^(succeeded|failed|cancelled)$/);
  return (await api<JobRow>(page, "GET", `/jobs/${jobId}`)).json;
}

test.beforeAll(async () => {
  await resetWorkspace();
});

test("프로파일 정의를 고쳐 새 리비전을 저장하고 대표 문서로 다시 승인한다(전체 재파싱은 돌기 전에 취소)", async ({ page }) => {
  const errors = collectErrors(page);
  const profile = await seededProfile(page);
  expect(profile.current_rev).toBe(1);
  const target = await documentRefs(page, TARGET);
  const witness = await documentRefs(page, WITNESS);
  const reference = await documentRefs(page, REFERENCE);

  // 출발점: 두 문서 모두 시드 리비전(헤드 r1 · 값 영역 60행)으로 발행돼 있다.
  for (const app of [target, witness]) {
    const before = await heads(page, app.application_id);
    expect(before.get("temperature")).toMatchObject({ revision_no: 1, rows: SEED_ROWS, status: "approved" });
    expect(await valueCount(page, app.snapshot_id, "temperature")).toBe(12);
  }

  // ---- 정의 JSON을 고쳐 저장하면 새 리비전(v2)이 된다(§4.2 · 프로파일 화면).
  await page.goto(`/?screen=profiles&profile=${profile.profile_id}`);
  const detail = page.getByRole("region", { name: "프로파일 상세" });
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V1 })).toBeVisible();
  const editor = detail.getByLabel("프로파일 JSON");
  const original = JSON.parse(await editor.inputValue()) as { description: string; rules: { selector: { value: { areas: { relative?: { rows?: number } }[] } } }[] };
  original.description = NEW_DESCRIPTION;
  let narrowed = 0;
  for (const rule of original.rules) {
    const relative = rule.selector.value.areas[0].relative;
    // 단위 영역(rows: 1)은 건드리지 않는다 — LOT 표의 값 영역만 좁힌다.
    if (relative?.rows === SEED_ROWS) {
      relative.rows = NARROW_ROWS;
      narrowed += 1;
    }
  }
  expect(narrowed, "LOT 표 열 규칙 7개의 값 영역을 좁힌다").toBe(7);
  await editor.fill(JSON.stringify(original, null, 2));
  await expect(detail.locator("[aria-label='검증 결과'] .app-chip")).toHaveText(["parsing-profile-3.0", "오류 없음"]);
  await detail.getByRole("button", { name: "저장(새 리비전)" }).click();
  await expect(page.getByRole("status").filter({ hasText: `${PROFILE_V2} 저장됨` })).toBeVisible();
  await expect(detail.getByRole("heading", { level: 2, name: PROFILE_V2 })).toBeVisible();
  expect((await api(page, "GET", `/profiles/${profile.profile_id}`)).json).toMatchObject({ current_rev: 2, status: "approved", description: NEW_DESCRIPTION });

  // ---- 대표 문서로 다시 승인해 기준 서명을 v2에서 계산한다(§4.8). 승인이 큐에 넣는 **전체** 재파싱은
  // 이 스펙의 관심사가 아니므로 바로 취소한다 — 그래야 '한 건만 돌았다'를 다른 문서로 확인할 수 있다.
  const approved = await api<{ reference_profile_rev: number; reparse_job: { job_id: string } }>(page, "POST", `/profiles/${profile.profile_id}/approve`, {
    application_id: reference.application_id,
  });
  expect(approved.status).toBe(200);
  expect(approved.json.reference_profile_rev).toBe(2);
  const cancelled = await api(page, "POST", `/jobs/${approved.json.reparse_job.job_id}/cancel`);
  expect(cancelled.status).toBeLessThan(300);
  expect((await waitForJob(page, approved.json.reparse_job.job_id)).state).toBe("cancelled");
  await waitForJobs(page);

  // 전체 재파싱은 대상 문서·확인용 문서에 닿지 못했다 — 둘 다 옛 리비전 그대로다.
  for (const app of [target, witness]) {
    expect((await heads(page, app.application_id)).get("temperature")).toMatchObject({ revision_no: 1, rows: SEED_ROWS });
  }
  errors.assertClean();
});

test("문서 상세 · 적용 프로파일 행의 `다시 파싱` — 그 문서만 새 리비전으로 발행하고, 다시 누르면 이미 최신으로 건너뛴다", async ({ page }) => {
  const errors = collectErrors(page);
  const profile = await seededProfile(page);
  expect(profile.current_rev).toBe(2);
  const target = await documentRefs(page, TARGET);
  const witness = await documentRefs(page, WITNESS);

  await page.goto("/?screen=documents");
  await expect(page.getByRole("heading", { level: 1, name: "문서" })).toBeVisible();
  // 이번 항목은 문서 상세에만 붙는다 — 문서 목록에는 다시 파싱이 없다(계약 §7).
  await expect(page.getByRole("table", { name: "문서 목록" }).getByRole("button", { name: "다시 파싱" })).toHaveCount(0);

  const detail = await openDocument(page, TARGET);
  const tabs = detail.getByRole("tablist");

  // ---- 다시 파싱 전의 추출 결과: 시드 리비전 그대로라 값이 한 쪽(50행)에 다 들어가지 않는다.
  await tabs.getByRole("tab", { name: "추출 결과" }).click();
  const values = detail.getByRole("table", { name: "추출 결과" });
  await expect(values.locator("tbody tr")).toHaveCount(50);
  await expect(detail.getByRole("button", { name: "다음", exact: true })).toBeEnabled();

  // ---- 적용 프로파일 행: 원본 보기 · 다시 파싱 · 프로파일 열기.
  await tabs.getByRole("tab", { name: "적용 프로파일" }).click();
  const applications = detail.getByRole("table", { name: "적용 프로파일" });
  const row = applications.locator("tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row.getByRole("cell").nth(1)).toHaveText("발행");
  await expect(row.getByRole("cell").nth(3)).toHaveText("11/11");
  await expect(row.getByRole("cell").nth(5).getByRole("button")).toHaveText(["원본 보기", "다시 파싱", "프로파일 열기"]);
  const button = row.getByRole("button", { name: "다시 파싱", exact: true });
  // 툴팁은 추출을 약속하지 않는다 — 이미 최신이면 원본을 읽지도, 값을 다시 뽑지도 않는다(§4.9 up_to_date).
  await expect(button).toHaveAttribute("title", "이 문서를 같은 프로파일의 현재 리비전으로 다시 맞춥니다(이미 최신이면 아무것도 하지 않습니다).");

  // 진행 중 표시(`다시 파싱 중…` · 비활성)를 확실히 보려고 **첫** 요청만 1.5초 늦춘다 — 응답은 그대로 서버가 만든다.
  let delayed = false;
  await page.route("**/api/applications/*/reparse*", async (route) => {
    if (!delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  const request = page.waitForRequest((r) => r.method() === "POST" && r.url().includes(`/api/applications/${target.application_id}/reparse`));
  await button.click();
  await expect(row.getByRole("button", { name: "다시 파싱 중…" })).toBeDisabled();
  await expect(detail.getByText("다시 파싱이 진행 중입니다. 닫아도 상단의 진행 중 작업 표시에서 확인할 수 있습니다.")).toBeVisible();
  expect(new URL((await request).url()).searchParams.get("wait")).toBe("10");

  // 끝나면 토스트가 문서·프로파일 리비전·값 개수를 말한다.
  await expect(page.getByRole("status").filter({ hasText: `${TARGET} · ${PROFILE_V2} 다시 파싱 완료 · 값 ${NARROWED_VALUES}개` })).toBeVisible({ timeout: 60_000 });
  await expect(detail.getByRole("alert")).toHaveCount(0);
  await expect(button).toBeEnabled();
  // 발행 상태는 그대로 발행이다(새 리비전으로 다시 뽑아 발행했다).
  await expect(row.getByRole("cell").nth(1)).toHaveText("발행");
  await expect(row.getByRole("cell").nth(4)).toHaveText("발행");
  // 적용 프로파일 행의 리비전은 **적용 당시**(v1) 그대로다 — 다시 파싱은 헤드 스펙만 현재 리비전으로 올린다.
  await expect(row.getByRole("cell").nth(0)).toHaveText(PROFILE_V1);

  // ---- 추출 결과 탭: 좁힌 리비전이 이 문서에 닿았다 — 값이 46개로 줄고 온도는 6행(C9~C14)만 남는다.
  await tabs.getByRole("tab", { name: "추출 결과" }).click();
  await expect(values.locator("tbody tr")).toHaveCount(NARROWED_VALUES);
  // 한 쪽에 다 들어가므로 쪽 넘김 자체가 사라진다(Pager는 다음 쪽이 없고 첫 쪽이면 그리지 않는다).
  await expect(detail.getByRole("button", { name: "다음", exact: true })).toHaveCount(0);
  await detail.getByLabel("파싱 규칙").selectOption({ label: "온도" });
  await expect(values.locator("tbody tr")).toHaveCount(NARROW_ROWS);
  await expect(values.locator("tbody tr").first().getByRole("cell").nth(2)).toHaveText("150");
  await expect(values.locator("tbody tr").first().getByRole("cell").nth(3)).toHaveText("°C");
  await expect(values.locator("tbody tr").first().getByRole("cell").nth(4)).toHaveText("공정 기록!C9");
  await expect(values.locator("tbody tr").nth(5).getByRole("cell").nth(4)).toHaveText("공정 기록!C14");

  // API로도 같은 것을 본다: 헤드는 r2(자동 승인) · 값 영역 6행, 발행된 실행이 있다.
  const after = await heads(page, target.application_id);
  expect(after.get("temperature")).toMatchObject({ revision_no: 2, rows: NARROW_ROWS, status: "approved", origin: "auto" });
  // 스펙이 실제로 바뀐 규칙만 새 리비전을 받는다 — 좁힌 LOT 표 열 규칙 7개는 r2, 그대로인 머리 정보 4개는 r1이다.
  expect([...after].filter(([, h]) => h.revision_no === 2).map(([key]) => key).sort()).toEqual(COLUMN_RULES);
  expect([...after].filter(([, h]) => h.revision_no === 1).map(([key]) => key).sort()).toEqual(SCALAR_RULES);
  const applied = await api<{ items: { published: boolean; state: string; heads_approved: number; heads_total: number }[] }>(page, "GET", `/snapshots/${target.snapshot_id}/applications`);
  expect(applied.json.items[0]).toMatchObject({ published: true, state: "published", heads_approved: 11, heads_total: 11 });
  expect(await valueCount(page, target.snapshot_id, "temperature")).toBe(NARROW_ROWS);

  // ---- 같은 버튼을 한 번 더: 이미 현재 리비전이라 건너뛴다(§4.9 up_to_date).
  await tabs.getByRole("tab", { name: "적용 프로파일" }).click();
  await button.click();
  // 이 갈래는 원본을 읽지 않고 판정한다 — 문구가 '원본이 바뀌었으면 다시 등록하라'까지 말해야 낡은 원본을 최신으로 오해하지 않는다.
  await expect(
    page.getByRole("status").filter({ hasText: `${TARGET} · ${PROFILE_V2} 다시 파싱 건너뜀 · 이미 최신입니다 — 다시 뽑을 것이 없습니다. 원본 파일이 바뀌었으면 문서를 다시 등록하세요` }),
  ).toBeVisible({ timeout: 60_000 });
  await expect(detail.getByRole("alert")).toHaveCount(0);
  const unchanged = await heads(page, target.application_id);
  expect(unchanged.get("temperature")).toMatchObject({ revision_no: 2, rows: NARROW_ROWS });

  // ---- 다른 문서는 손대지 않았다 — 같은 프로파일을 쓰지만 옛 리비전(60행·값 12개) 그대로다.
  const other = await heads(page, witness.application_id);
  expect(other.get("temperature")).toMatchObject({ revision_no: 1, rows: SEED_ROWS });
  expect([...other.values()].every((h) => h.revision_no === 1)).toBe(true);
  expect(await valueCount(page, witness.snapshot_id, "temperature")).toBe(12);
  expect(await valueCount(page, witness.snapshot_id)).toBe(50);

  // ---- 작업 내역: 한 건 재파싱 작업 2건(처리됨 · 건너뜀)이 같은 라벨로 남는다.
  await detail.press("Escape");
  await expect(detailOf(page)).toHaveCount(0);
  await waitForJobs(page);
  const jobs = await api<{ items: JobRow[] }>(page, "GET", "/jobs?kind=reparse");
  const single = jobs.json.items.filter((j) => j.target_kind === "application" && j.target_id === target.application_id);
  expect(single).toHaveLength(2);
  for (const job of single) {
    expect(job.state).toBe("succeeded");
    expect(job.label).toBe(`${TARGET} · ${PROFILE_V2} · 다시 파싱`);
  }
  expect(single.map((j) => j.result.outcome).sort()).toEqual(["건너뜀", "처리됨"]);
  await openScreen(page, "작업 내역");
  await expect(page.getByText(`${TARGET} · ${PROFILE_V2} · 다시 파싱`).first()).toBeVisible();
  errors.assertClean();
});
