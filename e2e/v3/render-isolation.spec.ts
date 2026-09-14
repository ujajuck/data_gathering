// 렌더 격리 E2E(계약 §5·§8 render-isolation.spec): 첫 렌더는 별도 렌더 서버(202 → 폴링 → 200)를 거치고, 캐시 재접근은 1초 안에 셀이 보이며
// ETag/If-None-Match → 304, Cache-Control은 private, no-cache. 큰 시트를 렌더하는 동안에도 문서 목록 API와 화면 이동은 막히지 않는다.
// 이미지는 별도 asset(/render-assets/<sha256>.png, loading="lazy")로 내려온다. 측정값은 `[timing]` 줄로 출력한다(보고서에 옮긴다).
import { test, expect } from "@playwright/test";
import type { APIResponse, Page } from "@playwright/test";
import { api, collectErrors, openDocument, openScreen, registerViaApi, resetWorkspace, runPython, waitForJobs, workspaceRoot } from "./helpers";

const IMAGE_DOCUMENT = "공정데이터_2024_03.xlsx";
const MAIN_SHEET = "공정 기록";
const IMAGE_SHEET = "첨부";
const HEAVY_SHEET = "부속 자료";
const HEAVY_ROWS = 2000;
const HEAVY_COLS = 90;
const RENDER_PORT = process.env.KG_E2E_V3_RENDER_PORT || "8032";
const RENDER_URL = `http://127.0.0.1:${RENDER_PORT}`;
const NO_CACHE = "private, no-cache";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const timings: string[] = [];
function record(metric: string, value: number, unit = "ms") {
  const line = `${metric}: ${Math.round(value)} ${unit}`;
  timings.push(line);
  console.log(`[timing] ${line}`);
}

type RenderStatus = { queue_depth: number; rendering: number; renderer_version: string; cache_bytes: number };

async function renderStatus(page: Page): Promise<RenderStatus> {
  const response = await page.request.get(`${RENDER_URL}/render/status`);
  expect(response.status(), "렌더 서버 상태는 200이어야 한다").toBe(200);
  return (await response.json()) as RenderStatus;
}

// 응답 시간을 재면서 GET을 부른다.
async function timedGet(page: Page, url: string, headers?: Record<string, string>): Promise<{ response: APIResponse; ms: number }> {
  const started = performance.now();
  const response = await page.request.get(url, headers ? { headers } : undefined);
  return { response, ms: performance.now() - started };
}

async function snapshotAndSheet(page: Page, documentName: string, sheetName: string) {
  const list = await api(page, "GET", "/documents?q=" + encodeURIComponent(documentName));
  expect(list.json.items).toHaveLength(1);
  const snapshotId = list.json.items[0].current_snapshot.snapshot_id as string;
  expect(snapshotId).toMatch(UUID);
  const sheets = await api(page, "GET", `/snapshots/${snapshotId}/sheets`);
  const sheet = sheets.json.items.find((s: { sheet_name: string }) => s.sheet_name === sheetName);
  expect(sheet, `${documentName}에 ${sheetName} 시트가 있어야 한다`).toBeTruthy();
  return { documentId: list.json.items[0].document_id as string, snapshotId, sheetId: sheet.sheet_id as string };
}

// 뷰어가 부른 렌더 창 요청(/render?range=)의 상태 코드를 순서대로 모은다.
function collectRenderResponses(page: Page): number[] {
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (response.request().method() === "GET" && /\/api\/v3\/snapshots\/[^/]+\/sheets\/[^/]+\/render\?/.test(response.url())) statuses.push(response.status());
  });
  return statuses;
}

const cellOf = (scope: ReturnType<Page["locator"]>, ref: string) => scope.locator(`.v3-viewer .v3-cell[data-ref="${ref}"]`);

test.afterAll(() => {
  console.log("[timing] summary\n" + timings.map((line) => "  " + line).join("\n"));
});

// 스펙 파일마다 새 작업 공간(시드 상태)에서 시작한다 — 전체 스위트를 한 서버로 돌릴 때 다른 스펙의 상태와 격리.
test.beforeAll(async () => {
  await resetWorkspace();
});

test("첫 렌더(별도 렌더 서버) · 캐시 재접근 < 1초 · ETag/304 · Cache-Control · 이미지 asset", async ({ page }) => {
  const errors = collectErrors(page);
  const renderStatuses = collectRenderResponses(page);
  await page.goto("/?screen=documents");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();

  // 렌더는 메인 API와 다른 프로세스(http 모드)가 맡는다. 새 작업 공간이므로 캐시는 비어 있다.
  const before = await renderStatus(page);
  expect(before.renderer_version).toBeTruthy();
  expect(before).toMatchObject({ queue_depth: 0, rendering: 0, cache_bytes: 0 });
  const status = await api(page, "GET", "/status");
  expect(status.status).toBe(200);
  expect(status.json.render).toMatchObject({ mode: "http", url: RENDER_URL, available: true, queue_depth: 0, rendering: 0, renderer_version: before.renderer_version });

  // (1) 첫 렌더: 드로어(파일 보기) 열기 → 셀이 보일 때까지. 첫 요청은 202(큐)이고 폴링 끝에 200이 온다.
  const firstStarted = performance.now();
  const detail = await openDocument(page, IMAGE_DOCUMENT);
  const sheetList = detail.locator(".v3-side-list");
  await expect(sheetList.getByRole("button")).toHaveCount(3);
  await expect(sheetList.getByRole("button").nth(0)).toContainText(MAIN_SHEET);
  await expect(sheetList.getByRole("button").nth(0)).toHaveAttribute("aria-current", "true");
  await expect(sheetList.getByRole("button").nth(2)).toContainText(IMAGE_SHEET);
  await expect(cellOf(detail, "C8")).toHaveText("온도", { timeout: 60_000 });
  record("first render (open drawer → cells visible, 공정 기록)", performance.now() - firstStarted);
  await expect(cellOf(detail, "C9")).toHaveText("150");
  await expect(cellOf(detail, "A9")).toHaveText("LOT-03-001");
  await expect(cellOf(detail, "A1")).toHaveText("공정 데이터 기록 · 검증용 가상 데이터");
  await expect(detail.locator(".v3-viewer").getByText("렌더링 중")).toHaveCount(0);
  await expect(detail.locator(".v3-viewer").getByRole("alert")).toHaveCount(0);
  expect(renderStatuses.length, "첫 렌더는 202 폴링을 거친다").toBeGreaterThanOrEqual(2);
  expect(renderStatuses[0]).toBe(202);
  expect(renderStatuses[renderStatuses.length - 1]).toBe(200);
  expect(renderStatuses.every((code) => code === 202 || code === 200)).toBe(true);
  record("first render polling round-trips (202 count)", renderStatuses.filter((code) => code === 202).length, "responses");

  // 렌더는 렌더 서버가 했다: 캐시 바이트가 늘고 renderer_version은 그대로.
  const after = await renderStatus(page);
  expect(after.renderer_version).toBe(before.renderer_version);
  expect(after.cache_bytes).toBeGreaterThan(0);
  expect(after).toMatchObject({ queue_depth: 0, rendering: 0 });
  const { snapshotId, sheetId } = await snapshotAndSheet(page, IMAGE_DOCUMENT, MAIN_SHEET);
  const rendered = await page.request.get(`${RENDER_URL}/render/${snapshotId}/sheets`);
  expect(rendered.status()).toBe(200);
  const renderedBody = await rendered.json();
  expect(renderedBody.items.map((s: { sheet_id: string }) => s.sheet_id)).toContain(sheetId);
  expect(renderedBody.pending).toEqual([]);

  // (2) 캐시 재접근 ①: 닫고 다시 열면 1초 안에 셀이 보인다(브라우저 안 GET 캐시 60초 — 창 요청이 네트워크로 나가지 않는다).
  await detail.press("Escape");
  await expect(detail).toHaveCount(0);
  renderStatuses.length = 0;
  const reopenStarted = performance.now();
  const reopenedInMemory = await openDocument(page, IMAGE_DOCUMENT);
  await expect(cellOf(reopenedInMemory, "C8")).toHaveText("온도");
  const reopenMs = performance.now() - reopenStarted;
  record("cached re-access (close → reopen drawer, in-memory client cache)", reopenMs);
  expect(reopenMs, "캐시된 시트는 1초 안에 보여야 한다").toBeLessThan(1000);
  await expect(reopenedInMemory.locator(".v3-viewer").getByText("렌더링 중")).toHaveCount(0);
  expect(renderStatuses, "브라우저 캐시가 살아 있으면 창 요청이 다시 나가지 않는다").toEqual([]);
  // 캐시 재접근 ②: 새로 고침으로 브라우저 캐시를 비우면 창 요청은 렌더 서버 캐시에서 202 없이 200으로 온다.
  await reopenedInMemory.press("Escape");
  await expect(reopenedInMemory).toHaveCount(0);
  await expect(page).not.toHaveURL(/document=/);
  await page.reload();
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();
  renderStatuses.length = 0;
  const reloadStarted = performance.now();
  const reopened = await openDocument(page, IMAGE_DOCUMENT);
  await expect(cellOf(reopened, "C8")).toHaveText("온도");
  const reloadMs = performance.now() - reloadStarted;
  record("cached re-access (after reload → open drawer → cells visible, render-server cache)", reloadMs);
  expect(reloadMs, "렌더 캐시된 시트는 새로 고침 뒤에도 1초 안에 보여야 한다").toBeLessThan(1000);
  await expect(reopened.locator(".v3-viewer").getByText("렌더링 중")).toHaveCount(0);
  expect(renderStatuses.length).toBeGreaterThanOrEqual(1);
  expect(renderStatuses.every((code) => code === 200), `캐시 재접근은 200만 받아야 한다: ${renderStatuses.join(",")}`).toBe(true);
  const sheetList2 = reopened.locator(".v3-side-list");

  // 창 URL 두 번: 200 + ETag → If-None-Match → 304. Cache-Control은 항상 private, no-cache(max-age·immutable 금지).
  const windowUrl = `/api/v3/snapshots/${snapshotId}/sheets/${sheetId}/render?range=A1:Z60`;
  const first = await timedGet(page, windowUrl);
  record("cached window GET (200)", first.ms);
  expect(first.response.status()).toBe(200);
  const etag = first.response.headers()["etag"];
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  expect(first.response.headers()["cache-control"]).toBe(NO_CACHE);
  const window = await first.response.json();
  expect(window.renderer_version).toBe(before.renderer_version);
  expect(window.sheet).toMatchObject({ sheet_id: sheetId, sheet_name: MAIN_SHEET });
  expect(window.range).toBe("A1:Z60");
  expect(window.cells.some((c: { text: string; r1: number; c1: number }) => c.text === "온도" && c.r1 === 8 && c.c1 === 3)).toBe(true);
  expect(window.images).toEqual([]);
  const second = await timedGet(page, windowUrl, { "If-None-Match": etag });
  record("cached window GET with If-None-Match (304)", second.ms);
  expect(second.response.status()).toBe(304);
  expect(second.response.headers()["etag"]).toBe(etag);
  expect(second.response.headers()["cache-control"]).toBe(NO_CACHE);
  expect(await second.response.text()).toBe("");
  // 프록시는 렌더 서버의 ETag를 그대로 전달한다.
  const direct = await page.request.get(`${RENDER_URL}/render/${snapshotId}/sheet/${sheetId}?range=A1:Z60`);
  expect(direct.status()).toBe(200);
  expect(direct.headers()["etag"]).toBe(etag);
  expect(direct.headers()["cache-control"]).toBe(NO_CACHE);
  // 잘못된 범위·창 상한(120×60)은 422로 거른다.
  const tooLarge = await page.request.get(`/api/v3/snapshots/${snapshotId}/sheets/${sheetId}/render?range=A1:ZZ500`);
  expect(tooLarge.status()).toBe(422);
  expect((await tooLarge.json()).error.code).toBe("RANGE_TOO_LARGE");

  // (4) 이미지 시트: <img loading="lazy" src="/api/v3/snapshots/<sid>/render-assets/<sha256>.png">.
  renderStatuses.length = 0;
  const imageStarted = performance.now();
  await sheetList2.getByRole("button", { name: new RegExp(IMAGE_SHEET) }).click();
  await expect(sheetList2.getByRole("button").nth(2)).toHaveAttribute("aria-current", "true");
  await expect(cellOf(reopened, "A1")).toHaveText("설비 사진", { timeout: 60_000 });
  record("first render (image sheet 첨부 → cells visible)", performance.now() - imageStarted);
  expect(renderStatuses[0]).toBe(202);
  const image = reopened.locator("img.v3-sheet-image");
  await expect(image).toHaveCount(1);
  await expect(image).toHaveAttribute("loading", "lazy");
  await expect(image).toHaveAttribute("alt", "시트 이미지");
  const src = (await image.getAttribute("src")) || "";
  const assetMatch = src.match(new RegExp(`^/api/v3/snapshots/${snapshotId}/render-assets/([0-9a-f]{64}\\.png)$`));
  expect(assetMatch, `이미지 src가 asset 경로여야 한다: ${src}`).toBeTruthy();
  const assetId = assetMatch![1];
  // 브라우저가 실제로 이미지를 받아 그렸다(24×24 PNG).
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), { message: "이미지가 로드돼야 한다" }).toBe(24);
  const imageSheet = (await api(page, "GET", `/snapshots/${snapshotId}/sheets`)).json.items.find((s: { sheet_name: string }) => s.sheet_name === IMAGE_SHEET);
  const imageWindow = await page.request.get(`/api/v3/snapshots/${snapshotId}/sheets/${imageSheet.sheet_id}/render?range=A1:Z60`);
  expect(imageWindow.status()).toBe(200);
  const imageBody = await imageWindow.json();
  expect(imageBody.images).toHaveLength(1);
  expect(imageBody.images[0]).toMatchObject({ asset_id: assetId, url: src });
  expect(JSON.stringify(imageBody)).not.toMatch(/data:image|base64/);

  const asset = await timedGet(page, src);
  record("render asset GET (200 image/png)", asset.ms);
  expect(asset.response.status()).toBe(200);
  expect(asset.response.headers()["content-type"]).toBe("image/png");
  expect(asset.response.headers()["cache-control"]).toBe(NO_CACHE);
  expect(asset.response.headers()["etag"]).toBe(`"${assetId}"`);
  const png = await asset.response.body();
  expect(png.length).toBeGreaterThan(0);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const assetNotModified = await page.request.get(src, { headers: { "If-None-Match": `"${assetId}"` } });
  expect(assetNotModified.status()).toBe(304);
  const directAsset = await page.request.get(`${RENDER_URL}/render/${snapshotId}/assets/${assetId}`);
  expect(directAsset.status()).toBe(200);
  expect(directAsset.headers()["content-type"]).toBe("image/png");
  expect((await directAsset.body()).equals(png)).toBe(true);
  // 형식이 어긋난 asset id·없는 asset·다른 확장자·없는 snapshot은 모두 404.
  for (const bad of ["abc.png", `${"0".repeat(64)}.svg`, `${"0".repeat(64)}.png`, assetId.toUpperCase(), assetId.replace(".png", ".png.tmp")]) {
    const missing = await page.request.get(`/api/v3/snapshots/${snapshotId}/render-assets/${encodeURIComponent(bad)}`);
    expect(missing.status(), `asset ${bad}`).toBe(404);
  }
  const wrongSnapshot = await page.request.get(`/api/v3/snapshots/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}/render-assets/${assetId}`);
  expect(wrongSnapshot.status()).toBe(404);

  await reopened.press("Escape");
  await expect(reopened).toHaveCount(0);
  errors.assertClean();
});

test("격리: 큰 시트를 렌더하는 동안 문서 목록 API < 500ms · 화면 이동 가능", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?screen=documents");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();

  // 큰 부속 시트(1,200행 × 50열)를 가진 문서를 원본 폴더에 만들고 등록한다(시드 문서 집합은 그대로).
  const heavyName = runPython(
    "import sys; from pathlib import Path; from examples.schema_v3.demo import write_heavy_document; print(write_heavy_document(Path(sys.argv[1]), rows=int(sys.argv[2]), cols=int(sys.argv[3])))",
    workspaceRoot(),
    String(HEAVY_ROWS),
    String(HEAVY_COLS),
  ).trim();
  const registerStarted = performance.now();
  const job = await registerViaApi(page, [heavyName]);
  record(`register heavy document (${HEAVY_ROWS}x${HEAVY_COLS})`, performance.now() - registerStarted);
  expect(job.result.documents[0]).toMatchObject({ document_name: heavyName });
  await waitForJobs(page);
  const { snapshotId, sheetId } = await snapshotAndSheet(page, heavyName, HEAVY_SHEET);
  const windowUrl = `/api/v3/snapshots/${snapshotId}/sheets/${sheetId}/render?range=A1:Z60`;
  const documentsUrl = "/api/v3/documents?limit=20";
  const expectedDocuments = (await api(page, "GET", documentsUrl.slice("/api/v3".length))).json.items.length;
  expect(expectedDocuments).toBeGreaterThanOrEqual(7);

  // (3) 렌더 시작: 캐시가 없으니 첫 GET은 즉시 202(queued|rendering)로 돌아온다 — 렌더 완료를 기다리지 않는다.
  const idle = await renderStatus(page);
  expect(idle).toMatchObject({ queue_depth: 0, rendering: 0 });
  const renderStarted = performance.now();
  const queued = await timedGet(page, windowUrl);
  record("render request → 202 (uncached heavy sheet)", queued.ms);
  expect(queued.response.status()).toBe(202);
  expect(queued.response.headers()["cache-control"]).toBe(NO_CACHE);
  const queuedBody = await queued.response.json();
  expect(["queued", "rendering"]).toContain(queuedBody.status);
  expect(queuedBody.job_id).toMatch(UUID);
  expect(queued.ms).toBeLessThan(2000);
  // 같은 키를 다시 부르면 새 작업을 만들지 않는다(멱등): 같은 job_id.
  const again = await page.request.get(windowUrl);
  expect(again.status()).toBe(202);
  expect((await again.json()).job_id).toBe(queuedBody.job_id);

  // 렌더 중에 문서 목록 API를 5번 재고, 매번 렌더가 아직 진행 중임을 렌더 서버 상태로 확인한다.
  const samples: number[] = [];
  let inProgressDuring = 0;
  for (let n = 0; n < 5; n++) {
    const live = await renderStatus(page);
    if (live.rendering + live.queue_depth >= 1) inProgressDuring++;
    const sample = await timedGet(page, documentsUrl);
    expect(sample.response.status()).toBe(200);
    expect((await sample.response.json()).items).toHaveLength(expectedDocuments);
    samples.push(sample.ms);
    expect(sample.ms, `렌더 중 문서 목록 응답 #${n + 1}`).toBeLessThan(500);
  }
  record("documents list during render (5 samples, max)", Math.max(...samples));
  record("documents list during render (5 samples, mean)", samples.reduce((a, b) => a + b, 0) / samples.length);
  expect(inProgressDuring, "다섯 번 모두 렌더가 진행 중이어야 한다").toBe(5);
  const apiStatus = await api(page, "GET", "/status");
  expect(apiStatus.json.render.rendering).toBe(1);
  const midRender = await page.request.get(windowUrl);
  expect(midRender.status()).toBe(202);
  expect((await midRender.json()).status).toBe("rendering");

  // 렌더 중에도 화면 이동(문서 → 파싱 스키마 → 문서)이 된다.
  const navigationStarted = performance.now();
  await openScreen(page, "파싱 스키마");
  await expect(page.getByRole("heading", { level: 1, name: "파싱 스키마" })).toBeVisible();
  await expect(page).toHaveURL(/screen=schema/);
  record("navigate 문서 → 파싱 스키마 during render", performance.now() - navigationStarted);
  const stillRendering = await renderStatus(page);
  expect(stillRendering.rendering + stillRendering.queue_depth, "화면 이동 뒤에도 렌더가 진행 중이어야 한다").toBeGreaterThanOrEqual(1);
  await openScreen(page, "문서");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();

  // 렌더가 끝나면 200 창이 오고 내용이 맞다(r*c 값). 캐시 바이트가 늘어난다.
  await expect
    .poll(async () => (await page.request.get(windowUrl)).status(), { timeout: 180_000, intervals: [500], message: "큰 시트 렌더가 끝나야 한다" })
    .toBe(200);
  record(`heavy sheet render (202 → 200, ${HEAVY_ROWS}x${HEAVY_COLS})`, performance.now() - renderStarted);
  const done = await page.request.get(windowUrl);
  const windowBody = await done.json();
  expect(windowBody.sheet).toMatchObject({ sheet_id: sheetId, sheet_name: HEAVY_SHEET });
  expect(windowBody).toMatchObject({ estimated_rows: HEAVY_ROWS, estimated_cols: HEAVY_COLS, truncated: false });
  const text = (r: number, c: number) => windowBody.cells.find((cell: { r1: number; c1: number }) => cell.r1 === r && cell.c1 === c)?.text;
  expect(text(1, 1)).toBe("1");
  expect(text(2, 2)).toBe("4");
  expect(text(60, 26)).toBe(String(60 * 26));
  expect(windowBody.cells.some((cell: { r1: number }) => cell.r1 > 60)).toBe(false);
  const settled = await renderStatus(page);
  expect(settled).toMatchObject({ queue_depth: 0, rendering: 0 });
  expect(settled.cache_bytes).toBeGreaterThan(idle.cache_bytes);
  // 마지막 창(A1141:Z1200)도 캐시에서 바로 온다.
  const tail = await timedGet(page, `/api/v3/snapshots/${snapshotId}/sheets/${sheetId}/render?range=A${HEAVY_ROWS - 59}:Z${HEAVY_ROWS}`);
  record("heavy sheet tail window GET (cached)", tail.ms);
  expect(tail.response.status()).toBe(200);
  const tailBody = await tail.response.json();
  expect(tailBody.cells.find((cell: { r1: number; c1: number }) => cell.r1 === HEAVY_ROWS && cell.c1 === 1)?.text).toBe(String(HEAVY_ROWS));
  errors.assertClean();
});

test("문서 목록 API 지연 기준선(10회)", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?screen=documents");
  await expect(page.getByRole("table", { name: "문서 목록" })).toBeVisible();
  const samples: number[] = [];
  for (let n = 0; n < 10; n++) {
    const sample = await timedGet(page, "/api/v3/documents");
    expect(sample.response.status()).toBe(200);
    const body = await sample.response.json();
    expect(body.items.length).toBeGreaterThanOrEqual(6);
    samples.push(sample.ms);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  record("documents list baseline (10 samples, mean)", mean);
  record("documents list baseline (10 samples, max)", Math.max(...samples));
  record("documents list baseline (10 samples, min)", Math.min(...samples));
  expect(Math.max(...samples)).toBeLessThan(500);
  errors.assertClean();
});
