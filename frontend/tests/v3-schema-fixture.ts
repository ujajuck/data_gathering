// 파싱 스키마 화면 테스트 픽스처: 공용 v3Fixture 위에 그룹 3개·폐기 필드·3단계 필드가 있는 트리, related_to 관계가 있는 그래프,
// 필드 필터를 존중하는 사용 프로파일/연관 문서, 필드 값(온도만 있음), PATCH 필드 편집, POST/PUT 스키마 가져오기를 덧붙인다.
import type { FieldDetail, FieldValueRow, SchemaGraph, SchemaRow, SchemaTree } from "../src/v3/types";
import { errorBody, ids, page, profileRows, reply, uuid, v3Fixture } from "./v3-fixture";

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
  const f = v3Fixture();
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
  };
  f.overrides.set("GET /schemas", () => page(state.schemas));
  for (const s of [state.schemas[0], SECOND_SCHEMA]) {
    f.overrides.set(`GET /schemas/${s.schema_key}`, () => ({ ...state.schemas.find((x) => x.schema_key === s.schema_key)!, description: s.schema_key === SCHEMA_KEY ? "공정 기록 표준 구조" : null }));
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
  f.overrides.set(`GET /schemas/${SCHEMA_KEY}/revisions`, () => page([
    { rev: 3, created_at: "2026-09-14T04:00:00Z", created_by: "admin", summary: "시간(초) 폐기" },
    { rev: 2, created_at: "2026-08-01T04:00:00Z", created_by: "admin", summary: "결과 정보 추가" },
    { rev: 1, created_at: "2026-07-01T04:00:00Z", created_by: null, summary: "최초" },
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
      const next = { ...state.fields.get(key)!, ...body };
      state.fields.set(key, next);
      return next;
    });
  }
  f.overrides.set("POST /schemas", (call) => {
    const definition = call.body?.definition;
    if (!definition || typeof definition !== "object") return reply(422, errorBody("INVALID_DEFINITION", "정의가 비어 있습니다."));
    state.imported.push(call.body!);
    const row: SchemaRow = { schema_key: definition.schema_key || "new_schema", schema_name: definition.schema_name || "새 스키마", current_rev: 1, status: "active", field_count: Array.isArray(definition.fields) ? definition.fields.length : 0, profile_count: 0, document_count: 0 };
    state.schemas = [...state.schemas, row];
    f.overrides.set(`GET /schemas/${row.schema_key}`, () => ({ ...row, description: null }));
    f.overrides.set(`GET /schemas/${row.schema_key}/tree`, () => ({ schema_key: row.schema_key, schema_name: row.schema_name, current_rev: 1, nodes: (definition.fields || []).map((x: Row) => ({ field_key: x.key, name: x.name, level: 1, children: [] })) }));
    return { ...row, description: null };
  });
  f.overrides.set(`PUT /schemas/${SCHEMA_KEY}`, (call) => {
    state.revised.push(call.body!);
    state.schemas = state.schemas.map((s) => (s.schema_key === SCHEMA_KEY ? { ...s, current_rev: s.current_rev + 1 } : s));
    return { ...state.schemas[0], description: "공정 기록 표준 구조" };
  });
  return { ...f, schema: state };
}
