// v3 E2E 공용 도우미(계약 §8). 모든 스펙이 같은 방식으로 오류를 모으고, 작업 공간·API·파이썬 검사를 쓴다.
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "../..");
export const MAIN_PORT = process.env.KG_E2E_V3_PORT || "8031";
export const CONTROL_PORT = process.env.KG_E2E_V3_CONTROL_PORT || String(Number(MAIN_PORT) + 10000);
export const PYTHON = process.env.KG_E2E_PYTHON || "python";
export const API_PREFIX = "/api/v3";

export const SCREEN_LABELS = ["문서", "파싱 프로파일", "파싱 스키마", "데이터 빌드", "작업 내역"] as const;
export type ScreenLabel = (typeof SCREEN_LABELS)[number] | "설정";

// pageerror + console.error(favicon 제외)를 모아 마지막에 비어 있음을 단언한다.
export function collectErrors(page: Page): { errors: string[]; assertClean: () => void } {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon")) errors.push("console.error: " + message.text());
  });
  return {
    errors,
    assertClean: () => expect(errors, "브라우저 오류가 없어야 한다").toEqual([]),
  };
}

// 새 작업 공간: serve.py(감독 프로세스)의 제어 서버에 리셋을 요청한다 — 새 임시 폴더를 시드하고 렌더/메인 서버를 다시 띄운다.
// 스펙 파일마다 test.beforeAll에서 부른다. 한 프로세스(webServer)로 전체 스위트를 돌릴 때 이전 스펙이 남긴 등록·승인·빌드 상태와 격리하기 위해서다.
export async function resetWorkspace(): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${CONTROL_PORT}/reset`, { method: "POST" });
  const body = (await response.json()) as { workspace?: string; generation?: number; error?: string };
  if (!response.ok || !body.workspace) throw new Error(`작업 공간 리셋 실패(${response.status}): ${body.error || JSON.stringify(body)}`);
  return body.workspace;
}

// serve.py가 기록한 임시 작업 공간 경로(.workspace 또는 .workspace-<port>).
export function workspaceRoot(): string {
  const marker = join(HERE, MAIN_PORT === "8031" ? ".workspace" : `.workspace-${MAIN_PORT}`);
  if (!existsSync(marker)) throw new Error(`작업 공간 표식이 없습니다: ${marker} (serve.py가 떠 있어야 합니다)`);
  return readFileSync(marker, "utf8").trim();
}

// 저장소 루트에서 파이썬 코드를 실행한다(PYTHONPATH=저장소 루트). 인자는 sys.argv[1:]로 전달된다.
export function runPython(code: string, ...args: string[]): string {
  return execFileSync(PYTHON, ["-c", code, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: [REPO_ROOT, process.env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":"), PYTHONIOENCODING: "utf-8" },
  });
}

// 새 snapshot 시나리오: 대표 문서의 값(온도·레시피)을 바꾼다. 문서 이름을 돌려준다.
export function mutateFirstDocument(): string {
  return runPython(
    "import sys; from pathlib import Path; from examples.schema_v3.demo import mutate_first_document; print(mutate_first_document(Path(sys.argv[1])))",
    workspaceRoot(),
  ).trim();
}

// 원본 폴더(<workspace>/data/raw) 안에서 파일을 복사한다(등록 대화상자 시나리오용).
export function copyRawDocument(from: string, to: string): string {
  return runPython(
    "import shutil, sys; from pathlib import Path; raw = Path(sys.argv[1]) / 'data/raw'; shutil.copyfile(raw / sys.argv[2], raw / sys.argv[3]); print(raw / sys.argv[3])",
    workspaceRoot(),
    from,
    to,
  ).trim();
}

// 원본 폴더 아래에 하위 폴더까지 있는 트리를 만든다(§4.1.1 폴더 일괄 등록 시나리오용).
// `copy_from`은 시드 문서를 복사하고(양식이 그대로라 프로파일 매치가 유지된다), `text`는 대상이 아닌 파일
// (`~$임시.xlsx`·`메모.txt`)을 만든다. 중간 폴더는 자동으로 만든다. 만든 경로(원본 폴더 기준)를 돌려준다.
export type RawTreeEntry = { path: string; copyFrom?: string; text?: string };

export function makeRawTree(entries: RawTreeEntry[]): string[] {
  const payload = entries.map((e) => ({ path: e.path, copy_from: e.copyFrom ?? null, text: e.text ?? "" }));
  const out = runPython(
    `import json, shutil, sys
from pathlib import Path
raw = Path(sys.argv[1]) / "data/raw"
made = []
for item in json.loads(sys.argv[2]):
    target = raw / item["path"]
    target.parent.mkdir(parents=True, exist_ok=True)
    if item["copy_from"]:
        shutil.copyfile(raw / item["copy_from"], target)
    else:
        target.write_text(item["text"], encoding="utf-8")
    made.append(item["path"])
print(json.dumps(made, ensure_ascii=False))`,
    workspaceRoot(),
    JSON.stringify(payload),
  );
  return JSON.parse(out) as string[];
}

// 새 snapshot 시나리오(하위 폴더 포함): 원본 폴더 기준 상대 경로의 A양식 문서 값(온도·레시피)을 바꾼다. 양식은 그대로다.
export function mutateRawDocument(sourceRef: string): string {
  return runPython(
    "import sys; from pathlib import Path; from examples.schema_v3.demo import mutate_document; print(mutate_document(Path(sys.argv[1]), sys.argv[2]))",
    workspaceRoot(),
    sourceRef,
  ).trim();
}

export type ApiResult<T = any> = { status: number; json: T };

// page.request로 v3 API를 호출한다(브라우저 컨텍스트와 같은 baseURL).
export async function api<T = any>(page: Page, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<ApiResult<T>> {
  const url = API_PREFIX + path;
  const options = body === undefined ? {} : { data: body };
  const response =
    method === "GET" ? await page.request.get(url) : method === "POST" ? await page.request.post(url, options) : method === "PUT" ? await page.request.put(url, options) : method === "PATCH" ? await page.request.patch(url, options) : await page.request.delete(url, options);
  const text = await response.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = text as unknown as T;
  }
  return { status: response.status(), json };
}

export type JobResponse = {
  job_id: string;
  kind: string;
  state: string;
  completed: number;
  total: number;
  result: any;
  error_code: string | null;
  error_message: string | null;
  label: string | null;
};

// POST /documents/register?wait=30 — 등록 + 자동 적용 + 추출을 한 작업으로 돌리고 최종 JobResponse를 돌려준다.
export async function registerViaApi(page: Page, sourceRefs: string[], provider = "local-xlsx"): Promise<JobResponse> {
  const { status, json } = await api<JobResponse>(page, "POST", "/documents/register?wait=30", { source_refs: sourceRefs, provider });
  expect(status, "등록 요청은 202/200이어야 한다").toBeLessThan(300);
  expect(json.state, `등록 작업 상태: ${JSON.stringify(json)}`).toBe("succeeded");
  return json;
}

// GET /jobs?state=running이 비어 있을 때까지 기다린다.
export async function waitForJobs(page: Page, timeout = 60_000): Promise<void> {
  await expect
    .poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/jobs?state=running")).json.items.length, { timeout, message: "진행 중 작업이 끝나야 한다" })
    .toBe(0);
}

// 사이드바 주 메뉴(또는 하단 설정) 버튼을 눌러 화면을 바꾼다.
export async function openScreen(page: Page, screen: ScreenLabel): Promise<void> {
  const nav = page.getByRole("navigation", { name: screen === "설정" ? "보조 메뉴" : "주 메뉴" });
  await nav.getByRole("button", { name: screen, exact: true }).click();
  await expect(nav.getByRole("button", { name: screen, exact: true })).toHaveAttribute("aria-current", "page");
}

// 문서 화면에서 문서명으로 검색해 행을 열고 상세 대화상자를 돌려준다.
export async function openDocument(page: Page, name: string) {
  const search = page.getByRole("search", { name: "문서 필터" }).getByLabel("문서 검색");
  await search.fill(name);
  const table = page.getByRole("table", { name: "문서 목록" });
  const row = table.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "문서 상세" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name, exact: true })).toBeVisible();
  return dialog;
}

// 다운로드 검사: CSV → 행 배열, XLSX → 첫 시트 헤더(파이썬 openpyxl).
export function readCsv(path: string): string[][] {
  const out = runPython(
    "import csv, json, sys; print(json.dumps(list(csv.reader(open(sys.argv[1], encoding='utf-8-sig', newline=''))), ensure_ascii=False))",
    path,
  );
  return JSON.parse(out) as string[][];
}

export function readXlsxHeaders(path: string, sheet?: string): string[] {
  const out = runPython(
    "import json, sys; from openpyxl import load_workbook; wb = load_workbook(sys.argv[1], read_only=True); ws = wb[sys.argv[2]] if len(sys.argv) > 2 and sys.argv[2] else wb.worksheets[0]; print(json.dumps([('' if c is None else str(c)) for c in next(ws.iter_rows(min_row=1, max_row=1, values_only=True))], ensure_ascii=False))",
    path,
    sheet || "",
  );
  return JSON.parse(out) as string[];
}

// SQLite 파일 질의(다운로드한 산출물 검사용). 한 행을 JSON 배열로 돌려준다.
export function sqliteRow(path: string, sql: string): unknown[] {
  const out = runPython("import json, sqlite3, sys; c = sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute(sys.argv[2]).fetchone(), ensure_ascii=False))", path, sql);
  return JSON.parse(out) as unknown[];
}
