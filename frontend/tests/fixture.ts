// 컴포넌트 테스트 픽스처: method+path 정규식 표로 라우팅하는 fetch 목(§6 형태의 표본 데이터).
// 사용법: const f = appFixture(); f.renderApp("?screen=documents"); await f.waitForApi(/\/documents/);
import { vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { resetClient } from "../src/app/client";
import { clearBuildDraft, reloadBuildDraft } from "../src/app/buildDraft";
import type {
  ApplicationSummary,
  BuildCandidates,
  DocumentRow,
  DocumentStatus,
  JobResponse,
  MappingRow,
  Page,
  ProfileDetail,
  ProfileRow,
  RenderWindow,
  SchemaRow,
  SearchHit,
  SheetRow,
  ValueRow,
} from "../src/app/types";
import { STATUS_ORDER } from "../src/app/types";
import { parseRange, formatRange } from "../src/app/sheetGeometry";
import Workbench from "../src/app/Workbench";

type Row = Record<string, any>;

// 실제 UUID/SHA-256 형태의 ID — 화면 텍스트에 새지 않는지(§7 표시 규칙) 검사할 수 있게 한다.
export const uuid = (n: number, tag = "0000") => `00000000-0000-4000-8000-${tag}${String(n).padStart(8, "0")}`;
export const sha256 = (n: number) => String(n).padStart(64, "0").replace(/0/g, "a").slice(0, 63) + String(n % 10);
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const SHA_RE = /\b[0-9a-f]{64}\b/i;

export const page = <T,>(items: T[], next: string | null = null): Page<T> => ({
  items,
  next_cursor: next,
  has_more: next !== null,
});

export type Reply = { __status: number; body: unknown; headers?: Record<string, string> };
export const reply = (status: number, body: unknown, headers?: Record<string, string>): Reply => ({
  __status: status,
  body,
  headers,
});
export const errorBody = (code: string, message: string, extra: Row = {}) => ({ error: { code, message }, ...extra });

export type Call = {
  method: string;
  path: string;
  url: URL;
  body: Row | undefined;
  headers: Record<string, string>;
};

export const ids = {
  snapshot: uuid(1, "aaaa"),
  snapshotOld: uuid(2, "aaaa"),
  sheet1: uuid(1, "bbbb"),
  sheetBig: uuid(2, "bbbb"),
  sheet3: uuid(3, "bbbb"),
  application: uuid(1, "cccc"),
  application2: uuid(2, "cccc"),
  profile: uuid(1, "dddd"),
  profile2: uuid(2, "dddd"),
  mapping1: uuid(1, "eeee"),
  mapping2: uuid(2, "eeee"),
  job: uuid(1, "ffff"),
  document: (n: number) => uuid(n, "0d0c"),
  value: (n: number) => uuid(n, "aa1e"),
};

const SCHEMA = { schema_key: "process_std", schema_name: "공정 데이터 표준" };
const NOW = Date.parse("2026-09-14T09:00:00Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60000).toISOString();

const DOCUMENT_NAMES = [
  "공정데이터_2024_01.xlsx",
  "공정데이터_2024_02.xlsx",
  "공정데이터_2024_03.xlsx",
  "구양식_2019_07.xlsx",
  "공정데이터_2024_04.xlsx",
  "손상파일_2024.xlsx",
  "보안문서_2024.xlsx",
];

export function documentRows(): DocumentRow[] {
  return STATUS_ORDER.map((status: DocumentStatus, i) => {
    const hasProfile = !["unmatched", "locked"].includes(status);
    return {
      document_id: ids.document(i + 1),
      document_name: DOCUMENT_NAMES[i],
      provider: status === "locked" ? "protected-reader" : "local-xlsx",
      file_type: "xlsx",
      status,
      status_detail: status === "review" ? "매핑 2건 검수 대기" : null,
      current_snapshot:
        status === "locked"
          ? null
          : {
              snapshot_id: i === 0 ? ids.snapshot : uuid(10 + i, "aaaa"),
              revision_no: i === 0 ? 2 : 1,
              captured_at: iso(60 * (i + 1)),
              change_token: sha256(i + 1),
              content_sha256: sha256(100 + i),
            },
      profiles: hasProfile
        ? [
            {
              profile_id: ids.profile,
              profile_name: "공정데이터_A양식",
              rev: 2,
              application_id: i === 0 ? ids.application : uuid(10 + i, "cccc"),
              state: status === "normal" ? "approved" : status === "failed" ? "failed" : "review",
              compatibility: status === "changed" ? "compatible" : "identical",
            },
            ...(i === 0
              ? [
                  {
                    profile_id: ids.profile2,
                    profile_name: "공정데이터_B양식",
                    rev: 1,
                    application_id: ids.application2,
                    state: "review",
                    compatibility: "compatible",
                  },
                ]
              : []),
          ]
        : [],
      schemas: hasProfile ? [SCHEMA] : [],
      last_processed_at: status === "locked" ? null : iso(30 * (i + 1)),
      last_error: status === "failed" ? "선택자 'find 온도'가 시트 Sheet1에서 셀을 찾지 못했습니다." : status === "locked" ? "DRM Reader가 필요합니다." : null,
    };
  });
}

export const sheetRows: SheetRow[] = [
  { sheet_id: ids.sheet1, sheet_name: "Sheet1", ordinal: 0, estimated_rows: 200, estimated_cols: 40 },
  { sheet_id: ids.sheetBig, sheet_name: "온도실험", ordinal: 1, estimated_rows: 2000, estimated_cols: 200 },
  { sheet_id: ids.sheet3, sheet_name: "원가", ordinal: 2, estimated_rows: 12, estimated_cols: 6 },
];

const SHEET_DIMS: Record<string, { rows: number; cols: number }> = {
  [ids.sheet1]: { rows: 200, cols: 40 },
  [ids.sheetBig]: { rows: 2000, cols: 200 },
  [ids.sheet3]: { rows: 12, cols: 6 },
};

export const ROW_HEIGHT = 24;
export const COLUMN_WIDTH = 80;

// 렌더 창(§5): rows/columns는 캐시 범위 전체, cells/merges/images는 range와 교차하는 것만. 좌표는 1부터.
export function renderWindow(sheetId: string, rangeText: string): RenderWindow {
  const dims = SHEET_DIMS[sheetId] || { rows: 60, cols: 26 };
  const requested = parseRange(rangeText) || { r1: 1, c1: 1, r2: 60, c2: 26 };
  const range = {
    r1: Math.max(1, requested.r1),
    c1: Math.max(1, requested.c1),
    r2: Math.min(dims.rows, requested.r2),
    c2: Math.min(dims.cols, requested.c2),
  };
  const rows = Array.from({ length: dims.rows }, (_, i) => ({ index: i + 1, y: i * ROW_HEIGHT, height: ROW_HEIGHT }));
  const columns = Array.from({ length: dims.cols }, (_, i) => ({ index: i + 1, x: i * COLUMN_WIDTH, width: COLUMN_WIDTH }));
  const sheet = sheetRows.find((s) => s.sheet_id === sheetId);
  const cells: RenderWindow["cells"] = [];
  const merges: RenderWindow["merges"] = [];
  const inRange = (r: number, c: number) => r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
  const put = (r: number, c: number, text: string, extra: Row = {}) => {
    if (inRange(r, c)) cells.push({ r1: r, c1: c, r2: extra.r2 ?? r, c2: extra.c2 ?? c, text, ...extra });
  };
  if (sheetId === ids.sheetBig) {
    for (let r = range.r1; r <= range.r2; r++) {
      put(r, 1, `실험 ${r}`);
      put(r, 2, String(100 + (r % 50)));
    }
  } else {
    const title = { r1: 1, c1: 1, r2: 1, c2: 3 };
    if (range.r1 <= 1 && range.c1 <= 3) {
      merges.push(title);
      put(1, 1, "공정 데이터 2024", { r2: 1, c2: 3, style: 0 });
    }
    ["공정명", "설비명", "온도(°C)", "압력(bar)", "시간(min)"].forEach((text, i) => put(2, i + 1, text, { style: 1 }));
    for (let r = 3; r <= dims.rows; r++) {
      put(r, 1, r % 2 ? "공정A" : "공정B");
      put(r, 2, r % 2 ? "설비1" : "설비2");
      put(r, 3, (100 + r * 0.7).toFixed(1));
      put(r, 4, (2 + (r % 5) * 0.3).toFixed(1));
      put(r, 5, String(30 + (r % 3) * 15));
    }
  }
  const images: RenderWindow["images"] = [];
  if (sheetId === ids.sheet1 && range.r1 <= 6 && range.c2 >= 8)
    images.push({
      asset_id: sha256(7) + ".png",
      url: `/api/snapshots/${ids.snapshot}/render-assets/${sha256(7)}.png`,
      x: 7 * COLUMN_WIDTH,
      y: 1 * ROW_HEIGHT,
      width: 160,
      height: 72,
    });
  return {
    renderer_version: "test-1",
    sheet: { sheet_id: sheetId, sheet_name: sheet?.sheet_name || "시트" },
    range: formatRange(range),
    rows,
    columns,
    width: dims.cols * COLUMN_WIDTH,
    height: dims.rows * ROW_HEIGHT,
    estimated_rows: dims.rows,
    estimated_cols: dims.cols,
    truncated: false,
    rendered_bounds: formatRange({ r1: 1, c1: 1, r2: dims.rows, c2: dims.cols }),
    freeze: null,
    styles: [
      { bold: true, align: "center", bg: "#e8f0ff" },
      { bold: true, bg: "#f8fafc" },
    ],
    cells,
    merges,
    images,
  };
}

export function valueRows(): ValueRow[] {
  return [3, 4, 5, 6, 7].map((r, i) => ({
    value_id: ids.value(i + 1),
    application_id: ids.application,
    rule_key: "temperature",
    rule_name: "온도",
    field: { key: "temperature", name: "온도", type: "float", unit: "°C" },
    profile: { profile_id: ids.profile, profile_name: "공정데이터_A양식", rev: 2 },
    record_key: `공정${r}`,
    value_text: (100 + r * 0.7).toFixed(1),
    display_text: (100 + r * 0.7).toFixed(1),
    unit_normalized: "°C",
    value_type: "float",
    value_state: "published",
    count: 1,
    first_region: { sheet_id: ids.sheet1, sheet_name: "Sheet1", range: `C${r}` },
    captured_at: iso(60),
  }));
}

export const mappingRows: MappingRow[] = [
  {
    mapping_id: ids.mapping1,
    rule_key: "temperature",
    rule_name: "온도",
    field: { key: "temperature", name: "온도", type: "float", unit: "°C" },
    observed_key: "온도(°C)",
    status: "approved",
    origin: "auto",
    effective_spec: { selector: { key: { areas: [{ sheet_role: "main", range: "C2" }] }, value: { areas: [{ sheet_role: "main", range: "C3:C7" }] } } },
    regions: [
      { role: "key", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "C2" },
      { role: "value", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "C3:C7" },
    ],
    revision_no: 1,
    edit_seq: 1,
    value: {
      value_id: ids.value(1),
      value_text: "102.1",
      display_text: "102.1",
      unit_normalized: "°C",
      value_type: "float",
      value_state: "published",
      count: 5,
      first_region: { sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "C3" },
    },
  },
  {
    mapping_id: ids.mapping2,
    rule_key: "pressure",
    rule_name: "압력",
    field: { key: "pressure", name: "압력", type: "float", unit: "bar" },
    observed_key: "압력(bar)",
    status: "proposed",
    origin: "profile",
    effective_spec: {},
    regions: [
      { role: "key", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "D2" },
      { role: "value", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "D3:D7" },
    ],
    revision_no: 1,
    edit_seq: 1,
    value: null,
  },
];

export function applicationSummary(): ApplicationSummary {
  const doc = documentRows()[0];
  return {
    application_id: ids.application,
    origin: "auto",
    compatibility: "identical",
    published: true,
    heads_approved: 1,
    heads_total: 2,
    document: { document_id: doc.document_id, document_name: doc.document_name },
    snapshot: doc.current_snapshot!,
    profile: { profile_id: ids.profile, profile_name: "공정데이터_A양식", rev: 2 },
    schema: { ...SCHEMA, rev: 3 },
    sheets: sheetRows.map((s, i) => ({ ...s, roles: i === 0 ? ["main"] : [] })),
    mappings: mappingRows,
  };
}

export const profileRows: ProfileRow[] = [
  {
    profile_id: ids.profile,
    profile_name: "공정데이터_A양식",
    current_rev: 2,
    schema: { key: SCHEMA.schema_key, name: SCHEMA.schema_name },
    status: "approved",
    document_count: 5,
    success_rate: 0.8,
    updated_at: iso(120),
  },
  {
    profile_id: ids.profile2,
    profile_name: "공정데이터_B양식",
    current_rev: 1,
    schema: { key: SCHEMA.schema_key, name: SCHEMA.schema_name },
    status: "draft",
    document_count: 1,
    success_rate: null,
    updated_at: iso(600),
  },
];

export function profileDetail(id: string): ProfileDetail {
  const row = profileRows.find((p) => p.profile_id === id) || profileRows[0];
  return {
    ...row,
    description: "A 양식 공정 기록",
    reference:
      row.status === "approved"
        ? {
            application_id: ids.application,
            document_id: ids.document(1),
            document_name: DOCUMENT_NAMES[0],
            snapshot: { snapshot_id: ids.snapshot, revision_no: 2, captured_at: iso(60) },
            approved_at: iso(100),
            profile_rev: 2,
          }
        : null,
    auto_approval_active: row.status === "approved",
    sheet_roles: { main: { match: { name: "Sheet1" } } },
    rules: [
      { rule_key: "temperature", rule_name: "온도", field: { key: "temperature", name: "온도", type: "float", unit: "°C" }, selector_summary: 'find "온도" → below', value_spec: { type: "float", unit: "°C" }, status: "active" },
      { rule_key: "pressure", rule_name: "압력", field: { key: "pressure", name: "압력", type: "float", unit: "bar" }, selector_summary: 'find "압력" → below', value_spec: { type: "float", unit: "bar" }, status: "active" },
    ],
  };
}

export const schemaRows: SchemaRow[] = [
  { ...SCHEMA, current_rev: 3, status: "active", field_count: 8, profile_count: 2, document_count: 5, updated_at: iso(300) },
];

export const schemaTree = {
  ...SCHEMA,
  current_rev: 3,
  nodes: [
    {
      field_key: "basic",
      name: "기본 정보",
      level: 1,
      children: [
        { field_key: "product_name", name: "제품명", level: 2, type: "string", children: [] },
        { field_key: "recipe_name", name: "레시피명", level: 2, type: "string", children: [] },
      ],
    },
    {
      field_key: "process",
      name: "공정 정보",
      level: 1,
      children: [
        { field_key: "temperature", name: "온도", level: 2, type: "float", unit: "°C", children: [] },
        { field_key: "pressure", name: "압력", level: 2, type: "float", unit: "bar", children: [] },
      ],
    },
  ],
};

export function job(overrides: Partial<JobResponse> = {}): JobResponse {
  return {
    job_id: ids.job,
    kind: "extract",
    state: "succeeded",
    completed: 1,
    total: 1,
    result: null,
    error_code: null,
    error_message: null,
    target_kind: "document",
    target_id: ids.document(1),
    label: DOCUMENT_NAMES[0],
    created_at: iso(10),
    started_at: iso(9),
    finished_at: iso(8),
    ...overrides,
  };
}

export function searchHits(q: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const d of documentRows())
    if (d.document_name.includes(q))
      hits.push({ kind: "document", id: d.document_id, label: d.document_name, sublabel: "문서", route: `?screen=documents&document=${d.document_id}` });
  for (const p of profileRows)
    if (p.profile_name.includes(q))
      hits.push({ kind: "profile", id: p.profile_id, label: `${p.profile_name} v${p.current_rev}`, sublabel: p.schema.name, route: { screen: "profiles", profile: p.profile_id } });
  for (const s of schemaRows)
    if (s.schema_name.includes(q))
      hits.push({ kind: "schema", id: s.schema_key, label: s.schema_name, sublabel: null, route: `?screen=schema&schema=${s.schema_key}` });
  return hits.slice(0, 15);
}

type Handler = (match: RegExpMatchArray, call: Call, f: Fixture) => unknown;
type Fixture = ReturnType<typeof appFixture>;

export function appFixture() {
  resetClient();
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // jsdom 기본 설정에서는 항상 사용 가능하다.
  }
  clearBuildDraft();
  reloadBuildDraft();
  const state = {
    requireToken: false,
    running: [] as JobResponse[],
    jobsRunning: 0,
    documents: documentRows(),
    applied: [] as Row[],
  };
  const calls: Call[] = [];
  const overrides = new Map<string, (call: Call) => unknown>();
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/status$/, () => ({ version: "3", workspace: "/tmp/ws", render: { mode: "inprocess", url: null, queue_depth: 0, rendering: 0 }, counts: { documents: state.documents.length, profiles: 2, schemas: 1, jobs_running: state.jobsRunning, review: 2 } })],
    ["GET", /^\/search$/, (_, call) => page(searchHits(call.url.searchParams.get("q") || ""))],
    ["GET", /^\/settings$/, () => ({ workspace: "/tmp/ws", render: { mode: "inprocess", url: null, renderer_version: "test-1" }, reader_factory: null, limits: { render_queue: 32, body_mb: 2 } })],
    ["GET", /^\/normalization-presets$/, () => page([{ id: "identity", label: "원값 유지", normalization: { operation: "identity" } }])],
    ["GET", /^\/sources$/, () => page([{ name: "샘플.xlsx", source_ref: "샘플.xlsx", directory: false }])],
    ["POST", /^\/documents\/register$/, (_, call) => job({ kind: "register", label: "문서 등록", result: { documents: (call.body?.source_refs || []).map((ref: string, i: number) => ({ document_id: uuid(50 + i, "0d0c"), document_name: ref, snapshot: null, status: "normal", applied: [] })) } })],
    [
      "GET",
      /^\/documents$/,
      (_, call) => {
        const q = call.url.searchParams.get("q") || "";
        const status = call.url.searchParams.get("status") || "";
        const sort = call.url.searchParams.get("sort") || "-last_processed_at";
        let items = state.documents.filter((d) => d.document_name.includes(q) && (!status || d.status === status));
        const key = sort.replace(/^-/, "") as keyof DocumentRow;
        items = [...items].sort((a, b) => String(a[key] ?? "").localeCompare(String(b[key] ?? "")) * (sort.startsWith("-") ? -1 : 1));
        return page(items);
      },
    ],
    ["GET", /^\/documents\/([^/]+)$/, (m) => state.documents.find((d) => d.document_id === m[1]) || reply(404, errorBody("NOT_FOUND", "문서를 찾을 수 없습니다."))],
    ["GET", /^\/documents\/([^/]+)\/snapshots$/, () => page([{ snapshot_id: ids.snapshot, revision_no: 2, captured_at: iso(60) }, { snapshot_id: ids.snapshotOld, revision_no: 1, captured_at: iso(60 * 24 * 10) }])],
    ["GET", /^\/snapshots\/([^/]+)\/sheets$/, () => page(sheetRows)],
    ["GET", /^\/snapshots\/([^/]+)\/applications$/, () => page([applicationSummary()])],
    ["POST", /^\/snapshots\/([^/]+)\/applications$/, (_, call) => {
      state.applied.push(call.body || {});
      return job({ kind: "extract", state: "succeeded", result: { application_id: ids.application2 } });
    }],
    ["GET", /^\/snapshots\/([^/]+)\/values$/, (_, call) => {
      const rule = call.url.searchParams.get("rule_key");
      return page(valueRows().filter((v) => !rule || v.rule_key === rule));
    }],
    ["GET", /^\/snapshots\/([^/]+)\/sheets\/([^/]+)\/render$/, (m, call) => renderWindow(m[2], call.url.searchParams.get("range") || "A1:Z60")],
    ["GET", /^\/profiles$/, (_, call) => {
      const q = call.url.searchParams.get("q") || "";
      return page(profileRows.filter((p) => p.profile_name.includes(q)));
    }],
    ["GET", /^\/profiles\/([^/]+)$/, (m) => profileDetail(m[1])],
    ["GET", /^\/profiles\/([^/]+)\/documents$/, () => page([{ document_id: ids.document(1), document_name: DOCUMENT_NAMES[0], snapshot: { snapshot_id: ids.snapshot, revision_no: 2 }, application_id: ids.application, profile_rev: 2, compatibility: "identical", heads_approved: 2, heads_total: 2, published: true, is_reference: true, status: "normal" }])],
    ["GET", /^\/profiles\/([^/]+)\/revisions$/, () => page([{ rev: 2, created_at: iso(120), summary: "규칙 추가" }, { rev: 1, created_at: iso(3000), summary: "최초" }])],
    ["GET", /^\/schemas$/, () => page(schemaRows)],
    ["GET", /^\/schemas\/([^/]+)$/, (m) => schemaRows.find((s) => s.schema_key === m[1]) || reply(404, errorBody("NOT_FOUND", "스키마를 찾을 수 없습니다."))],
    ["GET", /^\/schemas\/([^/]+)\/tree$/, () => schemaTree],
    ["GET", /^\/schemas\/([^/]+)\/graph$/, () => ({
      nodes: [
        { field_key: "process", name: "공정 정보", level: 1, type: null, parents: [], document_count: 5, profile_count: 2 },
        { field_key: "temperature", name: "온도", level: 2, type: "float", parents: ["process"], document_count: 5, profile_count: 2 },
      ],
      edges: [{ from: "process", to: "temperature", relation: "child" }],
    })],
    ["GET", /^\/schemas\/([^/]+)\/revisions$/, () => page([{ rev: 3, created_at: iso(300) }])],
    ["GET", /^\/schemas\/([^/]+)\/profiles$/, () => page(profileRows.map((p) => ({ profile_id: p.profile_id, profile_name: p.profile_name, current_rev: p.current_rev, status: p.status, rules: { count: 2, keys: ["temperature", "pressure"] }, document_count: p.document_count })))],
    ["GET", /^\/schemas\/([^/]+)\/documents$/, () => page(state.documents.filter((d) => d.schemas.length).map((d) => ({ document_id: d.document_id, document_name: d.document_name, profile: d.profiles[0], snapshot: d.current_snapshot, status: d.status, application_id: d.profiles[0].application_id })))],
    ["GET", /^\/schemas\/([^/]+)\/fields\/([^/]+)$/, (m) => ({ field_key: m[2], name: m[2] === "temperature" ? "온도" : m[2], description: "공정 설정 온도", type: "float", unit: "°C", aliases: ["온도값", "Temp"], parents: ["process"], children: [], related: ["pressure"], profile_count: 2, document_count: 5, status: "active" })],
    ["GET", /^\/schemas\/([^/]+)\/fields\/([^/]+)\/values$/, () => page(valueRows().map((v) => ({ text: v.value_text, value_id: v.value_id, sheet_id: ids.sheet1, sheet_name: "Sheet1", range: v.first_region!.range, application_id: ids.application, rule_key: v.rule_key, document_id: ids.document(1), document_name: DOCUMENT_NAMES[0], captured_at: v.captured_at })))],
    ["GET", /^\/applications\/([^/]+)$/, () => applicationSummary()],
    ["GET", /^\/applications\/([^/]+)\/mappings$/, () => page(mappingRows)],
    ["GET", /^\/applications\/([^/]+)\/values$/, () => page(valueRows())],
    ["GET", /^\/mappings\/([^/]+)\/revisions$/, () => page([{ mapping_revision_id: uuid(9, "eeee"), rule_key: "temperature", rule_name: "온도", field: mappingRows[0].field, observed_key: "온도(°C)", status: "approved", origin: "auto", effective_spec: {}, regions: mappingRows[0].regions, revision_no: 1, mapping_id: ids.mapping1, evidence: {}, reason: null, created_by: "system", created_at: iso(100) }])],
    ["GET", /^\/jobs$/, (_, call) => {
      const st = call.url.searchParams.get("state");
      if (st === "running") return page(state.running);
      return page([job(), job({ job_id: uuid(2, "ffff"), kind: "build", state: "failed", error_code: "INVALID_HEADER", error_message: "출력 Header가 비어 있습니다.", label: "빌드 3개 문서" }), ...state.running]);
    }],
    ["GET", /^\/jobs\/([^/]+)$/, (m) => state.running.find((j) => j.job_id === m[1]) || job({ job_id: m[1] })],
    ["POST", /^\/jobs\/([^/]+)\/cancel$/, (m) => job({ job_id: m[1], state: "cancelled" })],
    ["GET", /^\/queues$/, () => ({ counts: { unmatched: 1, review: 2, failed: 1, changed: 1, conflict: 0 } })],
    ["GET", /^\/queues\/([^/]+)$/, () => page([])],
    ["POST", /^\/builds\/candidates$/, (_, call) => {
      const wanted: string[] = call.body?.document_ids || [];
      const docs = state.documents.filter((d) => wanted.includes(d.document_id));
      const result: BuildCandidates = {
        documents: docs.map((d) => ({ document_id: d.document_id, document_name: d.document_name, usable: d.status === "normal", reason: d.status === "normal" ? null : d.status === "review" || d.status === "changed" ? "review_required" : (d.status as any), profile: d.profiles[0] || null })),
        summary: { total: docs.length, usable: docs.filter((d) => d.status === "normal").length, excluded: docs.filter((d) => d.status !== "normal").length },
        fields: [
          { field_key: "product_name", name: "제품명", type: "string", unit: null, document_count: docs.length },
          { field_key: "temperature", name: "온도", type: "float", unit: "°C", document_count: docs.length },
        ],
      };
      return result;
    }],
    ["POST", /^\/builds\/preview$/, (_, call) => ({ columns: call.body?.columns || [], rows: [], row_count: 0, excluded: [], conflicts: [] })],
    ["POST", /^\/builds$/, () => ({ build_key: "abcdef0123456789", download_url: "/api/builds/abcdef0123456789/download", manifest: { build_key: "abcdef0123456789", created_at: iso(0), schema: { key: SCHEMA.schema_key, rev: 3 }, sources: [], columns: [], row_mode: "record", row_count: 0, excluded: [], conflicts: [] } })],
  ];

  function answer(call: Call): unknown {
    const override = overrides.get(call.method + " " + call.path);
    if (override) return override(call);
    if (state.requireToken && !call.headers.authorization) return reply(401, errorBody("UNAUTHORIZED", "접근 토큰이 필요합니다."));
    for (const [method, pattern, handler] of routes) {
      if (method !== call.method) continue;
      const match = call.path.match(pattern);
      if (match) return handler(match, call, fixture);
    }
    throw new Error(`No fixture for ${call.method} ${call.path}`);
  }

  const fetchMock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, "http://component.test");
    const headers: Record<string, string> = {};
    new Headers(init.headers || {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: Call = {
      path: url.pathname.replace(/^\/api/, ""),
      method: (init.method || "GET").toUpperCase(),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      url,
      headers,
    };
    calls.push(call);
    const result = await answer(call);
    const marker = result as Reply;
    const status = marker && typeof marker === "object" && "__status" in marker ? marker.__status : 200;
    const body = status === 200 && !(marker && typeof marker === "object" && "__status" in marker) ? result : marker.body;
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...(marker && typeof marker === "object" && "__status" in marker ? marker.headers || {} : {}) },
    });
  });
  vi.stubGlobal("fetch", fetchMock);

  const fixture = {
    ids,
    state,
    calls,
    overrides,
    fetchMock,
    renderWindow,
    // 경로 정규식에 맞는 호출 목록.
    callsTo: (pattern: RegExp, method = "GET") => calls.filter((c) => c.method === method && pattern.test(c.path + c.url.search)),
    // 그 경로가 호출될 때까지 기다린다.
    waitForApi: (pattern: RegExp, method = "GET", count = 1) =>
      waitFor(() => {
        if (calls.filter((c) => c.method === method && pattern.test(c.path + c.url.search)).length < count)
          throw new Error(`waiting for ${method} ${pattern}`);
      }),
    // URL을 정하고 Workbench를 그린다.
    renderApp: (url = "?screen=documents") => {
      history.replaceState({}, "", url);
      return render(createElement(Workbench));
    },
  };
  return fixture;
}
