// Source Review 테스트 픽스처: 스캐폴드 appFixture를 확장해 검수 쓰기(리비전·복원·모두 승인)와 프로파일 테스트 응답을 더한다.
// 매핑 상태는 픽스처 안에서 갱신되어 다시 읽은 GET /applications/{aid}가 쓰기 결과를 반영한다.
import type { MappingRegion, MappingRow, MappingStatus, TestResult } from "../src/app/types";
import { applicationSummary, errorBody, ids, job, mappingRows, reply, uuid, appFixture } from "./fixture";
import type { Call } from "./fixture";

type Row = Record<string, any>;

export function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    bindings: { main: [ids.sheet1] },
    compatibility: "compatible",
    groups: [
      {
        rule_key: "temperature",
        field: { key: "temperature", name: "온도", type: "float", unit: "°C" },
        observed_key: "온도(°C)",
        regions: [
          { role: "key", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "C2" },
          { role: "value", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "C3:C7" },
        ],
        values: [3, 4, 5, 6, 7].map((r) => ({
          value_text: (100 + r * 0.7).toFixed(1),
          display_text: (100 + r * 0.7).toFixed(1),
          unit_normalized: "°C",
          region: { sheet_id: ids.sheet1, sheet_name: "Sheet1", range: `C${r}` },
        })),
        count: 5,
      },
      {
        rule_key: "pressure",
        field: { key: "pressure", name: "압력", type: "float", unit: "bar" },
        observed_key: "압력(bar)",
        regions: [
          { role: "key", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "D2" },
          { role: "value", sheet_id: ids.sheet1, sheet_name: "Sheet1", range: "D3:D7" },
        ],
        values: [],
        count: 0,
      },
    ],
    errors: [],
    ...overrides,
  };
}

export function sourceReviewFixture() {
  const f = appFixture();
  const review = {
    // 서버 쪽 매핑 상태(쓰기마다 갱신).
    mappings: mappingRows.map((m) => ({ ...m, regions: [...m.regions] })) as MappingRow[],
    // 다음 리비전 쓰기를 409 EDIT_CONFLICT로 거절한다.
    conflict: false,
    // 리비전 응답을 JobResponse(추출 결과)로 돌려준다.
    revisionAsJob: false,
    revisions: [] as Row[],
    rollbacks: [] as Row[],
    approveAll: [] as Row[],
    tests: [] as Row[],
    testResult: testResult(),
    testError: null as null | { status: number; code: string; message: string },
  };

  const summary = () => {
    const base = applicationSummary();
    return {
      ...base,
      mappings: review.mappings,
      heads_approved: review.mappings.filter((m) => m.status === "approved").length,
      heads_total: review.mappings.length,
      published: review.mappings.every((m) => m.status === "approved"),
    };
  };
  f.overrides.set("GET /applications/" + ids.application, summary);

  const revise = (mapping: MappingRow, call: Call) => {
    review.revisions.push({ mapping_id: mapping.mapping_id, ...(call.body || {}) });
    if (review.conflict) return reply(409, errorBody("EDIT_CONFLICT", "다른 리비전이 먼저 저장되었습니다."));
    const body = call.body || {};
    if (body.expected_seq !== mapping.edit_seq) return reply(409, errorBody("EDIT_CONFLICT", "expected_seq가 맞지 않습니다."));
    const regions: MappingRegion[] | undefined = body.regions?.map((r: Row) => ({
      role: r.role,
      sheet_id: r.sheet_id,
      sheet_name: r.sheet_id === ids.sheet1 ? "Sheet1" : "시트",
      range: r.range,
    }));
    const fieldKey = body.field_key as string | undefined;
    mapping.status = body.status as MappingStatus;
    mapping.origin = "manual";
    if (regions) mapping.regions = regions;
    if (fieldKey) mapping.field = { key: fieldKey, name: fieldKey === "pressure" ? "압력" : fieldKey === "temperature" ? "온도" : fieldKey, type: "float", unit: null };
    mapping.revision_no += 1;
    mapping.edit_seq += 1;
    if (review.revisionAsJob)
      return job({ kind: "extract", state: "succeeded", result: { application_id: ids.application, value_count: 5, published: true } });
    return { ...mapping };
  };
  const rollback = (mapping: MappingRow, call: Call) => {
    review.rollbacks.push({ mapping_id: mapping.mapping_id, ...(call.body || {}) });
    if (call.body?.expected_seq !== mapping.edit_seq) return reply(409, errorBody("EDIT_CONFLICT", "expected_seq가 맞지 않습니다."));
    mapping.status = "approved";
    mapping.revision_no += 1;
    mapping.edit_seq += 1;
    return { ...mapping };
  };
  for (const mapping of review.mappings) {
    f.overrides.set("POST /mappings/" + mapping.mapping_id + "/revisions", (call) => revise(mapping, call));
    f.overrides.set("POST /mappings/" + mapping.mapping_id + "/rollback", (call) => rollback(mapping, call));
    f.overrides.set("GET /mappings/" + mapping.mapping_id + "/revisions", () => ({
      items: [
        {
          mapping_revision_id: uuid(90, "eeee"),
          mapping_id: mapping.mapping_id,
          rule_key: mapping.rule_key,
          rule_name: mapping.rule_name,
          field: mapping.field,
          observed_key: mapping.observed_key,
          status: mapping.status,
          origin: mapping.origin,
          effective_spec: {},
          regions: mapping.regions,
          revision_no: mapping.revision_no,
          evidence: null,
          reason: null,
          created_by: "system",
          created_at: "2026-09-14T08:00:00Z",
        },
        {
          mapping_revision_id: uuid(91, "eeee"),
          mapping_id: mapping.mapping_id,
          rule_key: mapping.rule_key,
          rule_name: mapping.rule_name,
          field: mapping.field,
          observed_key: mapping.observed_key,
          status: "approved",
          origin: "auto",
          effective_spec: {},
          regions: mapping.regions,
          revision_no: 0,
          evidence: null,
          reason: "최초 자동 적용",
          created_by: "system",
          created_at: "2026-09-13T08:00:00Z",
        },
      ],
      has_more: false,
      next_cursor: null,
    }));
  }

  f.overrides.set("POST /applications/" + ids.application + "/approve-all", (call) => {
    review.approveAll.push({ wait: call.url.searchParams.get("wait"), ...(call.body || {}) });
    for (const mapping of review.mappings)
      if (mapping.status === "proposed") {
        mapping.status = "approved";
        mapping.revision_no += 1;
        mapping.edit_seq += 1;
      }
    return job({ kind: "extract", state: "succeeded", label: "공정데이터_2024_01.xlsx", result: { application_id: ids.application, value_count: 10, published: true } });
  });

  const runTest = (call: Call) => {
    review.tests.push({ path: call.path, ...(call.body || {}) });
    if (review.testError) return reply(review.testError.status, errorBody(review.testError.code, review.testError.message));
    return review.testResult;
  };
  f.overrides.set("POST /profiles/" + ids.profile + "/test", runTest);
  f.overrides.set("POST /profiles/" + ids.profile2 + "/test", runTest);
  f.overrides.set("POST /profiles/test", runTest);

  return { ...f, review, reviewUrl: (extra = "") => `?screen=documents&review=${ids.application}${extra}` };
}
