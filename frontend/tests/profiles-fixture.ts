// 파싱 프로파일 화면 테스트 픽스처: 공용 appFixture 위에 프로파일 쓰기 경로(import-preview · POST/PUT /profiles · approve ·
// reparse · export · revisions/{rev} · 저장된 리비전 테스트)와 상태 필터를 덧붙인다. 초안 테스트(POST /profiles/test)는 없다.
import type { ProfileDetail, ProfileDocumentRow, ProfileSaveResult } from "../src/app/types";
import { errorBody, ids, job, page, profileDetail, profileRows, reply, uuid, appFixture } from "./fixture";

type Row = Record<string, any>;

export const SCHEMA_KEY = "process_std";
export const NEW_PROFILE_ID = uuid(9, "dddd");

// 현재 리비전의 canonical 정의(§2).
export function canonicalDefinition(profileName = "공정데이터_A양식"): Row {
  return {
    format: "parsing-profile",
    schema_version: "3.0",
    profile_name: profileName,
    schema_key: SCHEMA_KEY,
    description: "A 양식 공정 기록",
    sheet_roles: { main: { cardinality: "one", match: { name: "Sheet1" } } },
    anchors: { hdr_temp: { sheet_role: "main", find: { texts: ["온도"], within: "A1:Z60" } } },
    rules: [
      {
        rule_key: "temperature",
        rule_name: "온도",
        field_key: "temperature",
        selector: {
          key: { areas: [{ sheet_role: "main", anchor: "hdr_temp" }], repeat: "once" },
          value: { areas: [{ sheet_role: "main", relative: { row: 1, col: 0, rows: 65, cols: 1 } }], cardinality: "list", axis: "down" },
          unit: { areas: [{ sheet_role: "main", relative: { row: 0, col: 1, anchor: "hdr_temp" } }] },
        },
        value_spec: { type: "decimal", unit: "°C", normalization: { operation: "identity", version: "1" } },
      },
      {
        rule_key: "pressure",
        rule_name: "압력",
        field_key: "pressure",
        selector: {
          key: { areas: [{ sheet_role: "main", find: { texts: ["압력"], within: "A1:Z60" } }] },
          value: { areas: [{ sheet_role: "main", relative: { row: 1, col: 0 } }] },
        },
        value_spec: { type: "decimal", unit: "bar" },
      },
    ],
  };
}

// 외부 형식 표본(generic-keyvalue): 어댑터가 canonical로 바꾸며 경고를 낸다.
export const GENERIC_DEFINITION = {
  fields: [
    { name: "온도", sheet: "Sheet1", label: "온도", offset: { row: 0, col: 1 }, type: "number", unit: "°C" },
    { name: "압력", sheet: "Sheet1", cell: "D3", type: "number", unit: "bar" },
  ],
};

export function profileDocumentRows(): ProfileDocumentRow[] {
  return [
    {
      document_id: ids.document(1),
      document_name: "공정데이터_2024_01.xlsx",
      snapshot: { snapshot_id: ids.snapshot, revision_no: 2, captured_at: "2026-09-14T08:00:00Z" },
      application_id: ids.application,
      profile_rev: 2,
      compatibility: "identical",
      heads_approved: 2,
      heads_total: 2,
      published: true,
      is_reference: false,
      status: "normal",
    },
    {
      document_id: ids.document(2),
      document_name: "공정데이터_2024_02.xlsx",
      snapshot: { snapshot_id: uuid(11, "aaaa"), revision_no: 1, captured_at: "2026-09-13T08:00:00Z" },
      application_id: uuid(11, "cccc"),
      profile_rev: 2,
      compatibility: "compatible",
      heads_approved: 1,
      heads_total: 2,
      published: false,
      is_reference: false,
      status: "review",
    },
  ];
}

function saveResult(detail: ProfileDetail, extra: Row = {}): ProfileSaveResult {
  return { ...detail, report: { format_detected: "parsing-profile-3.0", warnings: [] }, ...extra };
}

export function profilesFixture() {
  const f = appFixture();
  const state = {
    // 프로파일별 현재 정의(PUT으로 바뀐다).
    definitions: new Map<string, Row>([
      [ids.profile, canonicalDefinition()],
      [ids.profile2, canonicalDefinition("공정데이터_B양식")],
    ]),
    revs: new Map<string, number>([
      [ids.profile, 2],
      [ids.profile2, 1],
    ]),
    approved: [] as Row[],
    reparsed: [] as Row[],
    deprecated: [] as string[],
    deleted: [] as string[],
    saved: [] as Row[],
    documents: profileDocumentRows(),
  };
  const detailOf = (id: string): ProfileDetail => ({ ...profileDetail(id), current_rev: state.revs.get(id) ?? profileDetail(id).current_rev });

  f.overrides.set("GET /profiles", (call) => {
    const q = call.url.searchParams.get("q") || "";
    const status = call.url.searchParams.get("status") || "";
    return page(profileRows.filter((p) => p.profile_name.includes(q) && (!status || p.status === status)));
  });
  for (const id of [ids.profile, ids.profile2]) {
    f.overrides.set(`GET /profiles/${id}`, () => detailOf(id));
    f.overrides.set(`GET /profiles/${id}/documents`, () => page(state.documents));
    for (const rev of [1, 2, 3]) f.overrides.set(`GET /profiles/${id}/revisions/${rev}`, () => state.definitions.get(id));
    f.overrides.set(`GET /profiles/${id}/export`, () => state.definitions.get(id));
    f.overrides.set(`PUT /profiles/${id}`, (call) => {
      const definition = call.body?.definition;
      if (!definition || typeof definition !== "object") return reply(422, errorBody("INVALID_DEFINITION", "정의가 비어 있습니다."));
      if (definition.schema_key && definition.schema_key !== SCHEMA_KEY) return reply(422, errorBody("SCHEMA_IMMUTABLE", "스키마는 바꿀 수 없습니다."));
      state.definitions.set(id, definition);
      state.revs.set(id, (state.revs.get(id) || 1) + 1);
      state.saved.push({ id, definition });
      return saveResult(detailOf(id));
    });
    f.overrides.set(`POST /profiles/${id}/approve`, (call) => {
      state.approved.push({ id, ...(call.body || {}) });
      const row = state.documents.find((d) => d.application_id === call.body?.application_id);
      if (!row) return reply(422, errorBody("INVALID_APPLICATION", "이 프로파일의 적용 건이 아닙니다."));
      if (row.heads_approved !== row.heads_total) return reply(422, errorBody("REVIEW_REQUIRED", "검수되지 않은 규칙이 있습니다."));
      state.documents = state.documents.map((d) => ({ ...d, is_reference: d.application_id === row.application_id }));
      return { ...detailOf(id), status: "approved", auto_approval_active: true };
    });
    f.overrides.set(`POST /profiles/${id}/reparse`, (call) => {
      state.reparsed.push({ id, ...(call.body || {}) });
      return job({ kind: "reparse", label: "공정데이터_A양식 v2", target_kind: "profile", target_id: id, result: { queued: 3, skipped: [{ document_id: ids.document(6), document_name: "손상파일_2024.xlsx", reason: "locked" }] } });
    });
    f.overrides.set(`POST /profiles/${id}/test`, () => ({ bindings: { main: ["Sheet1"] }, compatibility: "identical", groups: [], errors: [] }));
    f.overrides.set(`POST /profiles/${id}/deprecate`, () => {
      state.deprecated.push(id);
      return { profile_id: id, profile_name: detailOf(id).profile_name, status: "deprecated" };
    });
    f.overrides.set(`DELETE /profiles/${id}`, () => {
      const detail = detailOf(id);
      // 적용된 문서가 있으면 지울 수 없다(§4.2.1) — 그때는 '폐기'만 가능하다.
      if (detail.document_count)
        return reply(409, errorBody("PROFILE_IN_USE", `이 프로파일은 문서 ${detail.document_count}개에 적용돼 있어 지울 수 없습니다. 더 쓰지 않으려면 '폐기'하세요.`));
      state.deleted.push(id);
      return { profile_id: id, profile_name: detail.profile_name, deleted: { rules: 2 } };
    });
  }
  // 형식 판별: parsing-profile → 그대로, fields[] → generic-keyvalue(경고), __invalid → 오류.
  f.overrides.set("POST /profiles/import-preview", (call) => {
    const definition: Row = call.body?.definition || {};
    if (call.body?.schema_key !== SCHEMA_KEY) return reply(422, errorBody("UNKNOWN_SCHEMA", "스키마를 찾을 수 없습니다."));
    if (definition.__invalid)
      return { format_detected: "parsing-profile-3.0", canonical: definition, warnings: [], errors: [{ code: "INVALID_SELECTOR", path: "rules[0].selector.value", message: "값 선택자가 비어 있습니다." }] };
    if (Array.isArray(definition.fields)) {
      const canonical = {
        ...canonicalDefinition("가져온 프로파일"),
        rules: definition.fields.map((field: Row, i: number) => ({ rule_key: `rule_${i + 1}`, rule_name: field.name, selector: { key: { areas: [{ sheet_role: "Sheet1", find: { texts: [field.label || field.name] } }] }, value: { areas: [{ sheet_role: "Sheet1", relative: { row: 0, col: 1 } }] } }, value_spec: { type: "decimal", unit: field.unit } })),
      };
      return {
        format_detected: "generic-keyvalue",
        canonical,
        warnings: [
          { code: "KEY_INFERRED", path: "fields[1]", message: "키를 필드명으로 추정했습니다." },
          { code: "MISSING_FIELD", path: "fields[0]", message: "연결할 필드가 지정되지 않았습니다." },
        ],
        errors: [],
      };
    }
    return { format_detected: "parsing-profile-3.0", canonical: definition, warnings: [], errors: [] };
  });
  f.overrides.set("POST /profiles", (call) => {
    if (call.body?.schema_key !== SCHEMA_KEY) return reply(422, errorBody("UNKNOWN_SCHEMA", "스키마를 찾을 수 없습니다."));
    state.saved.push({ id: NEW_PROFILE_ID, ...call.body });
    const name = call.body?.name || call.body?.definition?.profile_name || "새 프로파일";
    const detail: ProfileDetail = {
      ...profileDetail(ids.profile2),
      profile_id: NEW_PROFILE_ID,
      profile_name: name,
      current_rev: 1,
      status: "draft",
      reference: null,
      auto_approval_active: false,
      document_count: 0,
    };
    state.definitions.set(NEW_PROFILE_ID, call.body?.definition || {});
    state.revs.set(NEW_PROFILE_ID, 1);
    f.overrides.set(`GET /profiles/${NEW_PROFILE_ID}`, () => detail);
    f.overrides.set(`GET /profiles/${NEW_PROFILE_ID}/documents`, () => page([]));
    return saveResult(detail, { report: { format_detected: call.body?.format === "auto" && Array.isArray(call.body?.definition?.fields) ? "generic-keyvalue" : "parsing-profile-3.0", warnings: [] } });
  });
  return { ...f, profiles: state };
}
