// Source Review가 쓰는 순수 도우미: 역할·상태 라벨, 원본 위치 병합, overlay 변환, 필드 트리 평탄화, 작업 결과 요약.
import type { Overlay, OverlayKind } from "./SheetViewer";
import { parseRange } from "./sheetGeometry";
import type { Area, ChipClass, JobResponse, MappingRegion, MappingRow, MappingStatus, SchemaTreeNode } from "./types";
import { JOB_STATE_LABELS } from "./types";

export type RegionRole = "key" | "value" | "unit" | "context";
export const REGION_ROLES: RegionRole[] = ["key", "value", "unit", "context"];
export const ROLE_LABELS: Record<string, string> = {
  key: "키",
  value: "값",
  unit: "단위",
  context: "문맥",
  record_key: "레코드 키",
  input: "입력",
};
export const roleLabel = (role: string) => ROLE_LABELS[role] || role;

export const MAPPING_STATUS_LABELS: Record<MappingStatus, string> = {
  proposed: "제안",
  approved: "승인",
  rejected: "반려",
};
export const MAPPING_STATUS_CLASS: Record<MappingStatus, ChipClass> = {
  proposed: "warn",
  approved: "ok",
  rejected: "err",
};
export const mappingStatusLabel = (status: MappingStatus | null | undefined) =>
  status && status in MAPPING_STATUS_LABELS ? MAPPING_STATUS_LABELS[status] : "미검수";
export const mappingStatusClass = (status: MappingStatus | null | undefined): ChipClass =>
  status && status in MAPPING_STATUS_CLASS ? MAPPING_STATUS_CLASS[status] : "muted";

// 호환성 라벨은 types.ts의 공용 표를 그대로 쓴다(문서 등록·프로파일 상세와 같은 문구).
export { COMPATIBILITY_LABELS, compatibilityLabel } from "./types";

export const ORIGIN_LABELS: Record<string, string> = {
  profile: "프로파일",
  inherited: "승계",
  manual: "수동",
  import: "가져오기",
  auto: "자동",
};
export const originLabel = (value: string | null | undefined) => (value ? ORIGIN_LABELS[value] || value : "-");

// 다음 리비전에 보낼 원본 위치: 드래그로 다시 지정한 역할은 새 위치로 바꾸고 나머지 역할은 그대로 둔다.
export function mergeRegions(existing: MappingRegion[], pending: MappingRegion[]): MappingRegion[] {
  if (!pending.length) return existing;
  const replaced = new Set(pending.map((r) => r.role));
  return [...existing.filter((r) => !replaced.has(r.role)), ...pending];
}

// 같은 역할은 하나만 남긴다(드래그 재지정).
export function replaceRole(pending: MappingRegion[], next: MappingRegion): MappingRegion[] {
  return [...pending.filter((r) => r.role !== next.role), next];
}

export const isOverlayKind = (role: string): role is OverlayKind =>
  role === "key" || role === "value" || role === "unit" || role === "context";

export function overlaysFor(regions: { role: string; sheet_id: string; range: string }[], sheetId: string | undefined): Overlay[] {
  if (!sheetId) return [];
  const result: Overlay[] = [];
  for (const region of regions) {
    if (region.sheet_id !== sheetId || !isOverlayKind(region.role)) continue;
    const area = parseRange(region.range);
    if (area) result.push({ ...area, kind: region.role, label: roleLabel(region.role) });
  }
  return result;
}

// 초점 영역: URL range= → 현재 시트의 값 위치 → 현재 시트의 첫 위치.
export function focusFor(rangeText: string | undefined, regions: { role: string; sheet_id: string; range: string }[], sheetId: string | undefined): Area | null {
  if (rangeText) {
    const area = parseRange(rangeText);
    if (area) return area;
  }
  const onSheet = regions.filter((r) => r.sheet_id === sheetId);
  const first = onSheet.find((r) => r.role === "value") || onSheet[0];
  return first ? parseRange(first.range) : null;
}

export function regionsToRequest(regions: MappingRegion[]) {
  return regions.map(({ role, sheet_id, range }) => ({ role, sheet_id, range }));
}

export const countApproved = (mappings: MappingRow[]) => mappings.filter((m) => m.status === "approved").length;

export type FieldOption = { key: string; name: string; type?: string | null; unit?: string | null; group: string };

// 트리(중첩 응답 1회)에서 선택 가능한 필드(잎)만 뽑는다.
export function flattenFields(nodes: SchemaTreeNode[] | undefined, group = ""): FieldOption[] {
  if (!nodes) return [];
  const result: FieldOption[] = [];
  for (const node of nodes) {
    if (node.children && node.children.length) result.push(...flattenFields(node.children, node.name));
    else result.push({ key: node.field_key, name: node.name, type: node.type, unit: node.unit, group });
  }
  return result;
}

export const isJobResponse = (value: unknown): value is JobResponse =>
  !!value && typeof value === "object" && "job_id" in value && "state" in value;

export const isMappingRow = (value: unknown): value is MappingRow =>
  !!value && typeof value === "object" && "mapping_id" in value && "rule_key" in value;

// 작업 결과를 한 줄로(ID 없이): 상태 + result의 숫자 요약.
export function jobSummary(job: JobResponse): string {
  const parts = [JOB_STATE_LABELS[job.state] || job.state];
  const result = job.result || {};
  const numbers: [string, string][] = [
    ["value_count", "값"],
    ["values", "값"],
    ["extracted", "값"],
    ["queued", "대기"],
    ["approved", "승인"],
  ];
  for (const [key, label] of numbers) {
    const value = result[key];
    if (typeof value === "number") parts.push(`${label} ${value}개`);
  }
  if (result.published === true) parts.push("발행됨");
  if (job.error_message) parts.push(job.error_message);
  return parts.join(" · ");
}

export const formatValue = (value: { display_text?: string | null; value_text: string; unit_normalized?: string | null } | null | undefined) =>
  value ? `${value.display_text || value.value_text}${value.unit_normalized ? " " + value.unit_normalized : ""}` : "없음";
