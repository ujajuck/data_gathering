// Canonical Parsing Profile JSON(§2, DSL 3.0)을 화면에서 다루는 순수 함수. 규칙 폼은 이 모델을 불변으로 고쳐
// canonical JSON을 만들고 PUT /profiles/{id} {definition}으로 저장한다.

export type AreaKind = "range" | "find" | "relative" | "anchor";
export const AREA_KINDS: { id: AreaKind; label: string }[] = [
  { id: "range", label: "고정 범위" },
  { id: "find", label: "텍스트 찾기" },
  { id: "relative", label: "상대 위치" },
  { id: "anchor", label: "앵커" },
];

export type FindSpec = { texts?: string[]; regex?: string; within?: string; occurrence?: number };
export type RelativeSpec = { row: number; col: number; rows?: number; cols?: number; anchor?: string };
export type AreaSpec = {
  sheet_role?: string;
  range?: string;
  find?: FindSpec;
  relative?: RelativeSpec;
  anchor?: string;
};

export type SelectorRole = "key" | "value" | "unit" | "context";
export const SELECTOR_ROLES: { id: SelectorRole; label: string }[] = [
  { id: "key", label: "키" },
  { id: "value", label: "값" },
  { id: "unit", label: "단위" },
  { id: "context", label: "문맥" },
];

export type RoleSelector = {
  areas?: AreaSpec[];
  repeat?: string;
  cardinality?: string;
  axis?: string;
  [key: string]: unknown;
};

export type ValueSpec = {
  type?: string;
  unit?: string | null;
  source_unit?: string | null;
  normalization?: Record<string, unknown>;
  [key: string]: unknown;
};

export type RuleSpec = {
  rule_key: string;
  rule_name?: string;
  field_key?: string;
  selector?: Partial<Record<SelectorRole, RoleSelector>>;
  value_spec?: ValueSpec;
  [key: string]: unknown;
};

export type ProfileDefinition = {
  format?: string;
  schema_version?: string;
  profile_name?: string;
  schema_key?: string;
  description?: string;
  sheet_roles?: Record<string, unknown>;
  anchors?: Record<string, unknown>;
  rules?: RuleSpec[];
  [key: string]: unknown;
};

export const VALUE_TYPES = ["text", "decimal", "integer", "date", "boolean"];
export const CARDINALITIES = ["scalar", "list", "matrix"];
export const AXES = ["none", "down", "right", "row_major", "column_major"];

// 검증·Import 미리보기의 warnings/errors 항목: 문자열 또는 {code, path, message}.
export type Problem = string | { code?: string; path?: string | null; message?: string };

export function problemText(problem: Problem): string {
  if (typeof problem === "string") return problem;
  const parts = [problem.code, problem.path, problem.message].filter(Boolean);
  return parts.length ? parts.join(" · ") : JSON.stringify(problem);
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// 텍스트 → 정의 객체. JSON 문법 오류·객체가 아닌 값은 message로 돌려준다.
export function parseDefinition(text: string): { definition: ProfileDefinition | null; error: string } {
  if (!text.trim()) return { definition: null, error: "정의 JSON이 비어 있습니다." };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { definition: null, error: "정의는 JSON 객체여야 합니다." };
    return { definition: parsed as ProfileDefinition, error: "" };
  } catch (failure) {
    return { definition: null, error: "JSON 문법 오류: " + (failure instanceof Error ? failure.message : String(failure)) };
  }
}

export function newProfileSkeleton(schemaKey: string, profileName = "새 프로파일"): ProfileDefinition {
  return {
    format: "parsing-profile",
    schema_version: "3.0",
    profile_name: profileName,
    schema_key: schemaKey,
    description: "",
    sheet_roles: { main: { cardinality: "one", match: { ordinal: 0 } } },
    anchors: {},
    rules: [
      {
        rule_key: "rule_1",
        rule_name: "규칙 1",
        selector: {
          key: { areas: [{ sheet_role: "main", find: { texts: ["키"], within: "A1:AZ100" } }], repeat: "once" },
          value: { areas: [{ sheet_role: "main", relative: { row: 0, col: 1 } }], cardinality: "scalar" },
        },
        value_spec: { type: "text" },
      },
    ],
  };
}

export function areaKind(area: AreaSpec | undefined): AreaKind {
  if (!area) return "range";
  if (area.find) return "find";
  if (area.relative) return "relative";
  if (typeof area.anchor === "string") return "anchor";
  return "range";
}

export function emptyArea(kind: AreaKind, sheetRole: string): AreaSpec {
  const base: AreaSpec = sheetRole ? { sheet_role: sheetRole } : {};
  if (kind === "find") return { ...base, find: { texts: [], within: "A1:AZ100" } };
  if (kind === "relative") return { ...base, relative: { row: 0, col: 1, rows: 1, cols: 1 } };
  if (kind === "anchor") return { ...base, anchor: "" };
  return { ...base, range: "A1" };
}

export function areaSummary(area: AreaSpec): string {
  const role = area.sheet_role ? `[${area.sheet_role}] ` : "";
  switch (areaKind(area)) {
    case "find": {
      const find = area.find || {};
      const what = find.regex ? `/${find.regex}/` : (find.texts || []).map((t) => `"${t}"`).join(", ");
      return `${role}find ${what}${find.within ? " in " + find.within : ""}${find.occurrence !== undefined ? ` #${find.occurrence}` : ""}`;
    }
    case "relative": {
      const rel = area.relative!;
      const sign = (n: number) => (n >= 0 ? "+" + n : String(n));
      return `${role}relative (${sign(rel.row ?? 0)}, ${sign(rel.col ?? 0)}) ${rel.rows ?? 1}×${rel.cols ?? 1}${rel.anchor ? " from " + rel.anchor : ""}`;
    }
    case "anchor":
      return `${role}anchor ${area.anchor || "?"}`;
    default:
      return `${role}${area.range || "?"}`;
  }
}

export function selectorSummary(rule: RuleSpec, role: SelectorRole): string {
  const selector = rule.selector?.[role];
  if (!selector?.areas?.length) return "";
  const extras = [selector.repeat && selector.repeat !== "once" ? `repeat ${selector.repeat}` : "", role === "value" && selector.cardinality && selector.cardinality !== "scalar" ? `${selector.cardinality}${selector.axis && selector.axis !== "none" ? " " + selector.axis : ""}` : ""].filter(Boolean);
  return selector.areas.map(areaSummary).join(" | ") + (extras.length ? ` · ${extras.join(" · ")}` : "");
}

export function normalizationLabel(spec: ValueSpec | undefined): string {
  const normalization = spec?.normalization as { operation?: string; steps?: { op?: string }[] } | undefined;
  if (!normalization || !normalization.operation || normalization.operation === "identity") return "원값 유지";
  if (normalization.operation === "pipeline")
    return "pipeline: " + (normalization.steps || []).map((s) => s.op || "?").join(" → ");
  return normalization.operation;
}

export function ruleAt(definition: ProfileDefinition, ruleKey: string): RuleSpec | undefined {
  return (definition.rules || []).find((r) => r.rule_key === ruleKey);
}

export function replaceRule(definition: ProfileDefinition, ruleKey: string, next: RuleSpec | null): ProfileDefinition {
  const rules = definition.rules || [];
  const index = rules.findIndex((r) => r.rule_key === ruleKey);
  const list = index < 0 ? (next ? [...rules, next] : rules) : next ? rules.map((r, i) => (i === index ? next : r)) : rules.filter((_, i) => i !== index);
  return { ...definition, rules: list };
}

export function setRoleArea(rule: RuleSpec, role: SelectorRole, index: number, area: AreaSpec | null): RuleSpec {
  const selector = { ...(rule.selector || {}) };
  const current = { ...(selector[role] || {}) };
  const areas = [...(current.areas || [])];
  if (area) areas[index] = area;
  else areas.splice(index, 1);
  if (areas.length === 0) delete selector[role];
  else selector[role] = { ...current, areas };
  return { ...rule, selector };
}

export function setRoleOption(rule: RuleSpec, role: SelectorRole, key: string, value: unknown): RuleSpec {
  const selector = { ...(rule.selector || {}) };
  const current = { ...(selector[role] || {}) };
  if (value === undefined || value === "" || value === null) delete current[key];
  else current[key] = value;
  selector[role] = current;
  return { ...rule, selector };
}

export function splitTexts(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export const sheetRoleNames = (definition: ProfileDefinition | null | undefined): string[] =>
  Object.keys(definition?.sheet_roles || {});
export const anchorNames = (definition: ProfileDefinition | null | undefined): string[] =>
  Object.keys(definition?.anchors || {});

// sheet_roles[role].match 요약(기본 정보 탭).
export function sheetRoleSummary(spec: unknown): string {
  const role = (spec || {}) as { cardinality?: string; match?: Record<string, unknown> };
  const match = role.match || {};
  const describe = (m: Record<string, unknown>): string => {
    if (typeof m.name === "string") return `이름 = ${m.name}`;
    if (typeof m.name_regex === "string") return `이름 정규식 ${m.name_regex}`;
    if (typeof m.ordinal === "number") return `${m.ordinal + 1}번째 시트`;
    if (m.contains_text && typeof m.contains_text === "object") {
      const c = m.contains_text as { texts?: string[]; within?: string };
      return `텍스트 포함 ${(c.texts || []).join(", ")}${c.within ? " (" + c.within + ")" : ""}`;
    }
    if (Array.isArray(m.any_of)) return m.any_of.map((x) => describe((x || {}) as Record<string, unknown>)).join(" 또는 ");
    return "조건 없음";
  };
  return `${describe(match)}${role.cardinality === "many" ? " · 여러 시트" : ""}`;
}
