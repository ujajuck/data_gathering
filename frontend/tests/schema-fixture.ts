// 파싱 스키마 화면 테스트 픽스처: 공용 appFixture 위에 그룹 3개·폐기 필드·3단계 필드가 있는 트리, related_to 관계가 있는 그래프,
// 필드 필터를 존중하는 사용 프로파일/연관 문서, 필드 값(온도만 있음), PATCH 필드 편집(응답 = 필드 상세),
// POST(생성 전용 · 중복 키 409 SCHEMA_EXISTS)/PUT 스키마 가져오기, DELETE 스키마·필드(사용 중이면 409)를 덧붙인다.
import type { FieldDetail, FieldValueRow, SchemaGraph, SchemaRow, SchemaTree } from "../src/app/types";
import { errorBody, ids, page, profileRows, reply, uuid, appFixture } from "./fixture";

type Row = Record<string, any>;

export const SCHEMA_KEY = "process_std";
export const SCHEMA_NAME = "공정 데이터 표준";
export const SECOND_SCHEMA: SchemaRow = { schema_key: "recipe_std", schema_name: "레시피 표준", current_rev: 1, status: "active", field_count: 3, profile_count: 0, document_count: 0 };

export function schemaTreeFixture(): SchemaTree {
  return {
    schema_key: SCHEMA_KEY,
    schema_name: SCHEMA_NAME,
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
          { field_key: "process_name", name: "공정명", level: 2, type: "string", children: [] },
          { field_key: "temperature", name: "온도", level: 2, type: "float", unit: "°C", children: [] },
          { field_key: "pressure", name: "압력", level: 2, type: "float", unit: "bar", children: [] },
          {
            field_key: "duration",
            name: "시간",
            level: 2,
            type: "float",
            unit: "min",
            children: [{ field_key: "duration_sec", name: "시간(초)", level: 3, type: "float", unit: "s", status: "deprecated", children: [] }],
          },
        ],
      },
      {
        field_key: "result",
        name: "결과 정보",
        level: 1,
        children: [{ field_key: "judgement", name: "판정", level: 2, type: "string", children: [] }],
      },
    ],
  };
}

export function schemaGraphFixture(): SchemaGraph {
  return {
    nodes: [
      { field_key: "basic", name: "기본 정보", level: 1, type: null, parents: [], document_count: 5, profile_count: 2 },
      { field_key: "product_name", name: "제품명", level: 2, type: "string", parents: ["basic"], document_count: 5, profile_count: 2 },
      { field_key: "recipe_name", name: "레시피명", level: 2, type: "string", parents: ["basic"], document_count: 3, profile_count: 1 },
      { field_key: "process", name: "공정 정보", level: 1, type: null, parents: [], document_count: 5, profile_count: 2 },
      { field_key: "temperature", name: "온도", level: 2, type: "float", parents: ["process"], document_count: 5, profile_count: 2 },
      { field_key: "pressure", name: "압력", level: 2, type: "float", parents: ["process"], document_count: 4, profile_count: 2 },
      { field_key: "duration", name: "시간", level: 2, type: "float", parents: ["process"], document_count: 2, profile_count: 1 },
      { field_key: "duration_sec", name: "시간(초)", level: 3, type: "float", parents: ["duration"], document_count: 0, profile_count: 0 },
      { field_key: "result", name: "결과 정보", level: 1, type: null, parents: [], document_count: 1, profile_count: 1 },
      { field_key: "judgement", name: "판정", level: 2, type: "string", parents: ["result"], document_count: 1, profile_count: 1 },
    ],
    edges: [
      { from: "basic", to: "product_name", relation: "parent_of" },
      { from: "basic", to: "recipe_name", relation: "parent_of" },
      { from: "process", to: "temperature", relation: "parent_of" },
      { from: "process", to: "pressure", relation: "parent_of" },
      { from: "process", to: "duration", relation: "parent_of" },
      { from: "duration", to: "duration_sec", relation: "parent_of" },
      { from: "result", to: "judgement", relation: "parent_of" },
      { from: "temperature", to: "pressure", relation: "related_to" },
      { from: "recipe_name", to: "judgement", relation: "related_to" },
    ],
  };
}

const NAMES: Record<string, string> = {
  basic: "기본 정보",
  product_name: "제품명",
  recipe_name: "레시피명",
  process: "공정 정보",
  process_name: "공정명",
  temperature: "온도",
  pressure: "압력",
  duration: "시간",
  duration_sec: "시간(초)",
  result: "결과 정보",
  judgement: "판정",
};

export function fieldDetailFixture(key: string): FieldDetail {
  const base: FieldDetail = {
    field_key: key,
    name: NAMES[key] || key,
    description: null,
    type: "string",
    unit: null,
    aliases: [],
    parents: [],
    children: [],
    related: [],
    profile_count: 0,
    document_count: 0,
    status: "active",
  };
  if (key === "temperature")
    return { ...base, description: "공정 설정 온도", type: "float", unit: "°C", aliases: ["온도값", "Temp"], parents: ["process"], related: ["pressure"], profile_count: 2, document_count: 5 };
  if (key === "pressure") return { ...base, description: "공정 압력", type: "float", unit: "bar", aliases: ["압력값"], parents: ["process"], related: ["temperature"], profile_count: 2, document_count: 4 };
  if (key === "duration") return { ...base, type: "float", unit: "min", parents: ["process"], children: ["duration_sec"], profile_count: 1, document_count: 2 };
  if (key === "duration_sec") return { ...base, type: "float", unit: "s", parents: ["duration"], status: "deprecated" };
  if (key === "process") return { ...base, type: null, children: ["process_name", "temperature", "pressure", "duration"], profile_count: 2, document_count: 5 };
  return base;
}

export function temperatureValues(): FieldValueRow[] {
  return [3, 4, 5, 6, 7, 8].map((r, i) => ({
    text: (100 + r * 0.7).toFixed(1),
    value_id: ids.value(i + 1),
    sheet_id: ids.sheet1,
    sheet_name: "Sheet1",
    range: `C${r}`,
    application_id: i === 0 ? ids.application : uuid(10 + i, "cccc"),
    rule_key: "temperature",
    document_id: ids.document(1 + (i % 3)),
    document_name: ["공정데이터_2024_01.xlsx", "공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx"][i % 3],
    captured_at: new Date(Date.parse("2026-09-14T09:00:00Z") - (i + 1) * 3600000).toISOString(),
  }));
}

export function schemaFixture() {
  const f = appFixture();
  const state = {
    schemas: [
      { schema_key: SCHEMA_KEY, schema_name: SCHEMA_NAME, current_rev: 3, status: "active", field_count: 11, profile_count: 2, document_count: 5, updated_at: "2026-09-14T04:00:00Z" } as SchemaRow,
      SECOND_SCHEMA,
    ],
    fields: new Map<string, FieldDetail>(Object.keys(NAMES).map((k) => [k, fieldDetailFixture(k)])),
    patched: [] as Row[],
    imported: [] as Row[],
    revised: [] as Row[],
    profileFilters: [] as (string | null)[],
    documentFilters: [] as (string | null)[],
    deletedSchemas: [] as string[],
    deletedFields: [] as string[],
    created: [] as Row[],
    // 여기 있는 키는 삭제할 수 없다(SCHEMA_IN_USE · FIELD_IN_USE · FIELD_HAS_CHILDREN을 만든다).
    schemaInUse: new Set<string>(),
    fieldInUse: new Set<string>(),
    revs: new Map<string, number>([
      [SCHEMA_KEY, 3],
      [SECOND_SCHEMA.schema_key, 1],
    ]),
  };
  const schemaRef = (key: string) => {
    const row = state.schemas.find((x) => x.schema_key === key);
    return { key, name: row?.schema_name || key, rev: state.revs.get(key) ?? row?.current_rev ?? 1 };
  };
  const bumpRev = (key: string) => {
    const next = (state.revs.get(key) ?? 1) + 1;
    state.revs.set(key, next);
    state.schemas = state.schemas.map((x) => (x.schema_key === key ? { ...x, current_rev: next } : x));
    return next;
  };
  f.overrides.set("GET /schemas", () => page(state.schemas));
  for (const s of [state.schemas[0], SECOND_SCHEMA]) {
    f.overrides.set(`GET /schemas/${s.schema_key}`, () => {
      const row = state.schemas.find((x) => x.schema_key === s.schema_key);
      if (!row) return reply(404, errorBody("UNKNOWN_SCHEMA", "스키마를 찾을 수 없습니다."));
      return { ...row, description: s.schema_key === SCHEMA_KEY ? "공정 기록 표준 구조" : null };
    });
  }
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/tree`, () => {
    const tree = schemaTreeFixture();
    // PATCH로 바뀐 이름·상태를 트리에도 반영한다.
    const apply = (nodes: SchemaTree["nodes"]) => {
      for (const node of nodes) {
        const field = state.fields.get(node.field_key);
        if (field) {
          node.name = field.name;
          node.status = field.status;
        }
        apply(node.children);
      }
    };
    apply(tree.nodes);
    return tree;
  });
  f.overrides.set(`GET /schemas/${SECOND_SCHEMA.schema_key}/tree`, () => ({ schema_key: SECOND_SCHEMA.schema_key, schema_name: SECOND_SCHEMA.schema_name, current_rev: 1, nodes: [{ field_key: "recipe", name: "레시피", level: 1, children: [{ field_key: "recipe_code", name: "레시피 코드", level: 2, type: "string", children: [] }] }] }));
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/graph`, () => schemaGraphFixture());
  // 현재 정의(§6): '새 리비전'·'이름 바꾸기' 대화상자가 채울 때 쓴다.
  const definitionOf = (key: string) => ({
    schema_key: key,
    schema_name: state.schemas.find((x) => x.schema_key === key)?.schema_name || key,
    fields: [...state.fields.values()].map((x) => ({ key: x.field_key, name: x.name, type: x.type, unit: x.unit })),
  });
  for (const key of [SCHEMA_KEY, SECOND_SCHEMA.schema_key])
    for (const rev of [1, 2, 3, 4, 5]) f.overrides.set(`GET /schemas/${key}/revisions/${rev}`, () => definitionOf(key));
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/revisions`, () => page([
    { rev: 3, current: true, created_at: "2026-09-14T04:00:00Z", byte_size: 4096, field_count: 14 },
    { rev: 2, current: false, created_at: "2026-08-01T04:00:00Z", byte_size: 3600, field_count: 13 },
    { rev: 1, current: false, created_at: "2026-07-01T04:00:00Z", byte_size: 2400, field_count: 9 },
  ]));
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/profiles`, (call) => {
    const field = call.url.searchParams.get("field_key");
    state.profileFilters.push(field);
    const rows = profileRows.map((p) => ({ profile_id: p.profile_id, profile_name: p.profile_name, current_rev: p.current_rev, status: p.status, rules: { count: 2, keys: ["temperature", "pressure"] }, document_count: p.document_count }));
    return page(field === "temperature" ? rows : field ? [] : rows);
  });
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/documents`, (call) => {
    const field = call.url.searchParams.get("field_key");
    state.documentFilters.push(field);
    const docs = f.state.documents.filter((d) => d.schemas.length);
    const rows = docs.map((d) => ({ document_id: d.document_id, document_name: d.document_name, profile: d.profiles[0], snapshot: d.current_snapshot, status: d.status, application_id: d.profiles[0].application_id }));
    return page(field === "temperature" ? rows.slice(0, 3) : field ? [] : rows);
  });
  for (const key of Object.keys(NAMES)) {
    f.overrides.set(`GET /schemas/${SCHEMA_KEY}/fields/${key}`, () => state.fields.get(key));
    f.overrides.set(`GET /schemas/${SCHEMA_KEY}/fields/${key}/values`, (call) => {
      const limit = Number(call.url.searchParams.get("limit") || 50);
      return page(key === "temperature" ? temperatureValues().slice(0, limit) : []);
    });
    f.overrides.set(`PATCH /schemas/${SCHEMA_KEY}/fields/${key}`, (call) => {
      const body = call.body || {};
      if (body.name !== undefined && !String(body.name).trim()) return reply(422, errorBody("INVALID_FIELD", "필드명은 비울 수 없습니다."));
      state.patched.push({ key, ...body });
      // §6 B: 응답은 GET과 같은 필드 상세 + 저장 뒤 current_rev.
      const next = { ...state.fields.get(key)!, ...body, schema: { ...schemaRef(SCHEMA_KEY), rev: bumpRev(SCHEMA_KEY) } };
      state.fields.set(key, next);
      return next;
    });
    f.overrides.set(`DELETE /schemas/${SCHEMA_KEY}/fields/${key}`, () => {
      const field = state.fields.get(key)!;
      if (field.children.length)
        return reply(409, {
          error: {
            code: "FIELD_HAS_CHILDREN",
            message: `하위 필드 ${field.children.length}개가 있습니다. 먼저 하위 필드를 지우세요.`,
            detail: { children: field.children.map((c) => ({ field_key: c, name: NAMES[c] || c })), count: field.children.length },
          },
        });
      if (state.fieldInUse.has(key))
        return reply(409, {
          error: {
            code: "FIELD_IN_USE",
            message: "공정데이터_A양식 외 1개 프로파일이 이 필드를 씁니다. 추출값 5건이 남아 있습니다.",
            detail: {
              profiles: [{ profile_id: profileRows[0].profile_id, profile_name: profileRows[0].profile_name, rule_keys: [key] }],
              value_count: 5,
              mapping_count: 2,
            },
          },
        });
      state.deletedFields.push(key);
      state.fields.delete(key);
      return { schema_key: SCHEMA_KEY, field_key: key, name: field.name, current_rev: bumpRev(SCHEMA_KEY), fields_remaining: state.fields.size };
    });
  }
  f.overrides.set(`POST /schemas/${SCHEMA_KEY}/fields`, (call) => {
    const body = call.body || {};
    const key = String(body.field_key || "");
    if (state.fields.has(key)) return reply(409, errorBody("FIELD_EXISTS", "이미 있는 필드 키입니다."));
    if (body.parent_field_key && !state.fields.has(String(body.parent_field_key)))
      return reply(422, errorBody("UNKNOWN_PARENT", "상위 필드를 찾을 수 없습니다."));
    state.created.push(body);
    const field: FieldDetail = {
      field_key: key,
      name: String(body.name || key),
      description: body.description ?? null,
      type: body.type ?? null,
      unit: body.unit ?? null,
      aliases: [],
      parents: body.parent_field_key ? [String(body.parent_field_key)] : [],
      children: [],
      related: [],
      profile_count: 0,
      document_count: 0,
      status: "active",
      schema: { ...schemaRef(SCHEMA_KEY), rev: bumpRev(SCHEMA_KEY) },
    };
    state.fields.set(key, field);
    NAMES[key] = field.name;
    f.overrides.set(`GET /schemas/${SCHEMA_KEY}/fields/${key}`, () => state.fields.get(key));
    f.overrides.set(`GET /schemas/${SCHEMA_KEY}/fields/${key}/values`, () => page([]));
    return field;
  });
  f.overrides.set("POST /schemas", (call) => {
    const definition = call.body?.definition;
    if (!definition || typeof definition !== "object") return reply(422, errorBody("INVALID_DEFINITION", "정의가 비어 있습니다."));
    // 생성 전용: 이미 있는 키면 아무것도 쓰지 않고 409.
    if (state.schemas.some((x) => x.schema_key === definition.schema_key))
      return reply(409, errorBody("SCHEMA_EXISTS", "이미 있는 스키마 키입니다. 새 리비전으로 저장하려면 스키마를 열어 '새 리비전'을 쓰세요."));
    state.imported.push(call.body!);
    const row: SchemaRow = { schema_key: definition.schema_key || "new_schema", schema_name: definition.schema_name || "새 스키마", current_rev: 1, status: "active", field_count: Array.isArray(definition.fields) ? definition.fields.length : 0, profile_count: 0, document_count: 0 };
    state.schemas = [...state.schemas, row];
    f.overrides.set(`GET /schemas/${row.schema_key}`, () => ({ ...row, description: null }));
    f.overrides.set(`GET /schemas/${row.schema_key}/tree`, () => ({ schema_key: row.schema_key, schema_name: row.schema_name, current_rev: 1, nodes: (definition.fields || []).map((x: Row) => ({ field_key: x.key, name: x.name, level: 1, children: [] })) }));
    state.revs.set(row.schema_key, 1);
    return { schema_key: row.schema_key, schema_name: row.schema_name, current_rev: 1, unchanged: false, fields: { total: row.field_count, added: row.field_count, updated: 0, deprecated: 0 } };
  });
  f.overrides.set(`PUT /schemas/${SCHEMA_KEY}`, (call) => {
    state.revised.push(call.body!);
    const rev = bumpRev(SCHEMA_KEY);
    const fields = Array.isArray(call.body?.definition?.fields) ? call.body!.definition.fields.length : 0;
    return { schema_key: SCHEMA_KEY, schema_name: SCHEMA_NAME, current_rev: rev, unchanged: false, fields: { total: fields, added: 0, updated: fields, deprecated: 0 } };
  });
  for (const key of [SCHEMA_KEY, SECOND_SCHEMA.schema_key]) {
    f.overrides.set(`DELETE /schemas/${key}`, () => {
      const row = state.schemas.find((x) => x.schema_key === key);
      if (state.schemaInUse.has(key))
        return reply(409, {
          error: {
            code: "SCHEMA_IN_USE",
            message: "공정데이터_A양식, 공정데이터_B양식이 이 스키마를 씁니다. 적용 문서 5건이 남아 있습니다.",
            detail: {
              profiles: profileRows.map((p) => ({ profile_id: p.profile_id, profile_name: p.profile_name, current_rev: p.current_rev, status: p.status, document_count: p.document_count })),
              profile_count: profileRows.length,
              document_count: 5,
            },
          },
        });
      state.deletedSchemas.push(key);
      state.schemas = state.schemas.filter((x) => x.schema_key !== key);
      return { schema_key: key, schema_name: row?.schema_name || key, deleted: { fields: row?.field_count ?? 0, aliases: 3, edges: 2, revisions: 3 } };
    });
  }
  return { ...f, schema: state };
}
