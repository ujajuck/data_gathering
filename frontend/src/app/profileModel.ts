// Canonical Parsing Profile JSON(§2, DSL 3.0)을 화면에서 다루는 순수 함수.
// 정의는 화면에서 JSON 편집기로만 고친다(규칙 카드 편집기는 없앴다) — 여기 있는 것은 파싱·직렬화·빈 골격·문제 문구뿐이다.

export type ProfileDefinition = {
  format?: string;
  schema_version?: string;
  profile_name?: string;
  schema_key?: string;
  description?: string;
  sheet_roles?: Record<string, unknown>;
  anchors?: Record<string, unknown>;
  rules?: Record<string, unknown>[];
  [key: string]: unknown;
};

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

// '새 프로파일' 대화상자의 '빈 골격 넣기'.
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
