// 데이터 빌드 출력 설정(§7 Build 3단계)의 순수 모델: 컬럼 상태·헤더 검증·순서 변경·세션 저장.
// 문서 초안(buildDraft.ts)과 별도로 스키마별 출력 설정을 sessionStorage('schema.build.columns')에 둔다.
import type { BuildColumn, BuildField, RowMode } from "./types";

export type ColumnConfig = {
  field_key: string;
  name: string;
  type: string | null;
  unit: string | null;
  document_count: number;
  enabled: boolean;
  header: string;
};

export type OutputConfig = {
  schema_key: string;
  row_mode: RowMode;
  columns: { field_key: string; header: string; enabled: boolean }[];
};

export const BUILD_COLUMNS_KEY = "schema.build.columns";

export const ROW_MODE_LABELS: Record<RowMode, string> = {
  record: "레코드마다 1행",
  document: "문서마다 1행",
};

export const HEADER_BLANK = "출력 Header를 입력하세요.";
export const HEADER_DUPLICATE = "중복된 출력 Header입니다.";

export function readOutputConfig(schemaKey: string): OutputConfig | null {
  try {
    const raw = sessionStorage.getItem(BUILD_COLUMNS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OutputConfig>;
    if (parsed.schema_key !== schemaKey || !Array.isArray(parsed.columns)) return null;
    return {
      schema_key: schemaKey,
      row_mode: parsed.row_mode === "document" ? "document" : "record",
      columns: parsed.columns.filter((c) => c && typeof c.field_key === "string"),
    };
  } catch {
    return null;
  }
}

export function writeOutputConfig(config: OutputConfig) {
  try {
    sessionStorage.setItem(BUILD_COLUMNS_KEY, JSON.stringify(config));
  } catch {
    // 저장소를 쓸 수 없어도 화면 상태는 유지된다.
  }
}

export function clearOutputConfig() {
  try {
    sessionStorage.removeItem(BUILD_COLUMNS_KEY);
  } catch {
    // 무시
  }
}

// 서버 필드 목록과 저장된 설정을 합친다: 저장된 순서·헤더·사용 여부를 우선하고, 새 필드는 뒤에 붙인다.
export function mergeColumns(fields: BuildField[], saved: OutputConfig | null): ColumnConfig[] {
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const result: ColumnConfig[] = [];
  const seen = new Set<string>();
  for (const s of saved?.columns || []) {
    const field = byKey.get(s.field_key);
    if (!field || seen.has(s.field_key)) continue;
    seen.add(s.field_key);
    result.push(toConfig(field, s.header, s.enabled));
  }
  for (const field of fields) {
    if (seen.has(field.field_key)) continue;
    seen.add(field.field_key);
    result.push(toConfig(field, field.name, true));
  }
  return result;
}

function toConfig(field: BuildField, header: string, enabled: boolean): ColumnConfig {
  return {
    field_key: field.field_key,
    name: field.name,
    type: field.type ?? null,
    unit: field.unit ?? null,
    document_count: field.document_count ?? 0,
    enabled: enabled !== false,
    header: typeof header === "string" ? header : field.name,
  };
}

// 사용 중인 컬럼만 검사한다: 빈 값·중복(공백 제거 뒤 비교).
export function headerErrors(columns: ColumnConfig[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const counts = new Map<string, number>();
  for (const c of columns) {
    if (!c.enabled) continue;
    const key = c.header.trim();
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const c of columns) {
    if (!c.enabled) continue;
    const key = c.header.trim();
    if (!key) errors[c.field_key] = HEADER_BLANK;
    else if ((counts.get(key) || 0) > 1) errors[c.field_key] = HEADER_DUPLICATE;
  }
  return errors;
}

export function moveColumn(columns: ColumnConfig[], from: number, to: number): ColumnConfig[] {
  if (from === to || from < 0 || to < 0 || from >= columns.length || to >= columns.length) return columns;
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function toBuildColumns(columns: ColumnConfig[]): BuildColumn[] {
  return columns.filter((c) => c.enabled).map((c) => ({ field_key: c.field_key, header: c.header.trim() }));
}

export function toOutputConfig(schemaKey: string, rowMode: RowMode, columns: ColumnConfig[]): OutputConfig {
  return {
    schema_key: schemaKey,
    row_mode: rowMode,
    columns: columns.map((c) => ({ field_key: c.field_key, header: c.header, enabled: c.enabled })),
  };
}
