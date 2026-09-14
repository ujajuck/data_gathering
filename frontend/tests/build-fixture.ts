// 데이터 빌드 화면 테스트 픽스처: 공용 appFixture 위에 초안 문서, 미리보기 행(셀마다 원본 위치), 빌드 결과·manifest,
// 비동기(작업) 빌드 경로를 덧붙인다.
import type { BuildColumn, BuildManifest, BuildPreview, BuildResult, JobResponse, PreviewCell } from "../src/app/types";
import { addToBuildDraft } from "../src/app/buildDraft";
import { ids, job, uuid, appFixture } from "./fixture";

type Row = Record<string, any>;

export const BUILD_KEY = "abcdef0123456789";
export const SCHEMA_KEY = "process_std";
export const BUILD_JOB_ID = uuid(7, "ffff");

const RULE_BY_FIELD: Record<string, string> = { product_name: "product", temperature: "temperature" };
const TEXT_BY_FIELD: Record<string, (r: number) => string> = {
  product_name: (r) => `제품 ${r}`,
  temperature: (r) => (100 + r * 0.7).toFixed(1),
};

export function previewRows(columns: BuildColumn[], count = 3): PreviewCell[][] {
  return Array.from({ length: count }, (_, i) => {
    const r = i + 3;
    return columns.map((c) => ({
      text: (TEXT_BY_FIELD[c.field_key] || (() => "-"))(r),
      value_id: ids.value(r),
      sheet_id: ids.sheet1,
      sheet_name: "Sheet1",
      range: `${c.field_key === "temperature" ? "C" : "A"}${r}`,
      application_id: ids.application,
      rule_key: RULE_BY_FIELD[c.field_key] || c.field_key,
    }));
  });
}

export function manifestFor(body: Row): BuildManifest {
  const columns: BuildColumn[] = body.columns || [];
  return {
    build_key: BUILD_KEY,
    created_at: "2026-09-14T09:00:00Z",
    schema: { key: SCHEMA_KEY, rev: 3 },
    sources: [
      {
        document_id: ids.document(1),
        document_name: "공정데이터_2024_01.xlsx",
        snapshot_id: ids.snapshot,
        application_id: ids.application,
        run_id: uuid(1, "4a4a"),
        profile: { id: ids.profile, name: "공정데이터_A양식", rev: 2 },
      },
    ],
    columns: columns.map((c) => ({ ...c, type: c.field_key === "temperature" ? "float" : "string", unit: c.field_key === "temperature" ? "°C" : null })),
    row_mode: body.row_mode || "record",
    row_count: 120,
    excluded: [{ document_id: ids.document(2), document_name: "공정데이터_2024_02.xlsx", usable: false, reason: "review_required" }],
    conflicts: [],
  };
}

export function buildResult(body: Row): BuildResult {
  return { build_key: BUILD_KEY, download_url: `/api/builds/${BUILD_KEY}/download`, manifest: manifestFor(body) };
}

// 문서 1(정상)·2(검수 필요)·4(프로파일 없음)을 초안에 넣고 시작한다.
export function buildFixture(options: { documents?: number[]; schemaKey?: string; asyncBuild?: boolean } = {}) {
  const f = appFixture();
  const documents = options.documents ?? [1, 2, 4];
  if (documents.length) addToBuildDraft(documents.map((n) => ids.document(n)), options.schemaKey);
  const state = { ...f.state, asyncBuild: !!options.asyncBuild, jobPolls: 0 };

  f.overrides.set("POST /builds/preview", (call) => {
    const columns: BuildColumn[] = call.body?.columns || [];
    const preview: BuildPreview = {
      columns,
      rows: previewRows(columns),
      row_count: 120,
      excluded: [{ document_id: ids.document(2), document_name: "공정데이터_2024_02.xlsx", usable: false, reason: "review_required" }],
      conflicts: [{ document_id: ids.document(1), document_name: "공정데이터_2024_01.xlsx", field_key: "temperature", values: ["101.2", "101.5"], reason: "단위 불일치" }],
    };
    return preview;
  });
  f.overrides.set("POST /builds", (call) => {
    if (!state.asyncBuild) return buildResult(call.body || {});
    return job({ job_id: BUILD_JOB_ID, kind: "build", state: "running", completed: 1, total: 3, label: "빌드 3개 문서", result: null, finished_at: null });
  });
  f.overrides.set(`GET /jobs/${BUILD_JOB_ID}`, (call) => {
    state.jobPolls += 1;
    const body = f.callsTo(/^\/builds\?/, "POST").slice(-1)[0]?.body || {};
    const done: JobResponse = job({
      job_id: BUILD_JOB_ID,
      kind: "build",
      state: "succeeded",
      completed: 3,
      total: 3,
      label: "빌드 3개 문서",
      result: { build_key: BUILD_KEY, download_url: `/api/builds/${BUILD_KEY}/download`, manifest: manifestFor(body) },
    });
    void call;
    return done;
  });
  f.overrides.set(`GET /builds/${BUILD_KEY}/manifest`, () => {
    const body = f.callsTo(/^\/builds\?/, "POST").slice(-1)[0]?.body || {};
    return manifestFor(body);
  });

  return { ...f, buildState: state };
}
