// API 응답·요청 형태 (docs/design/contracts.md §5·§6·§7).
// 화면 표시 규칙(§7): UUID·SHA-256은 URL 파라미터와 API 호출에만 쓰고 화면 텍스트에는 쓰지 않는다.

export type Page<T> = {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
};

// 409 SCHEMA_IN_USE · FIELD_IN_USE · FIELD_HAS_CHILDREN이 함께 주는 근거(§6). 화면은 detail 없이 message만으로도 뜻이 통해야 한다.
export type ApiErrorDetail = {
  profiles?: { profile_id: string; profile_name: string; current_rev?: number; status?: string; document_count?: number; rule_keys?: string[] }[];
  profile_count?: number;
  document_count?: number;
  application_count?: number;
  children?: { field_key: string; name: string }[];
  count?: number;
  value_count?: number;
  mapping_count?: number;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, unknown> | string[];
    detail?: ApiErrorDetail;
  };
};

// ---------------------------------------------------------------- 문서

export type DocumentStatus =
  | "normal"
  | "review"
  | "changed"
  | "unmatched"
  | "not_extracted"
  | "failed"
  | "locked";

export type ChipClass = "ok" | "warn" | "err" | "muted";

// 상태 표(상태 필터·표·드로어 헤더 공용, §7).
export type DocumentStatusDetail = {
  applications?: number;
  unapproved?: number;
  inherited?: number;
  failed?: unknown[];
  incompatible?: unknown[];
  locked?: { code?: string } | null;
};

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  normal: "정상",
  review: "검수 필요",
  changed: "변경 감지",
  unmatched: "프로파일 없음",
  not_extracted: "재추출 필요",
  failed: "파싱 실패",
  locked: "잠김(DRM)",
};
export const STATUS_CLASS: Record<DocumentStatus, ChipClass> = {
  normal: "ok",
  review: "warn",
  changed: "warn",
  unmatched: "muted",
  not_extracted: "muted",
  failed: "err",
  locked: "err",
};
export const STATUS_ORDER: DocumentStatus[] = [
  "normal",
  "review",
  "changed",
  "unmatched",
  "not_extracted",
  "failed",
  "locked",
];

export type SnapshotRef = {
  snapshot_id: string;
  revision_no: number;
  captured_at: string;
  change_token?: string;
  content_sha256?: string | null;
};

export type ProfileRef = {
  profile_id: string;
  profile_name: string;
  rev: number;
  // 프로파일 상태(draft|approved|deprecated). `GET /snapshots/{sid}/applications`가 담아 보낸다 —
  // 문서 상세가 '다시 파싱이 막히는 행'을 누르기 **전에** 비활성으로 보이는 데 쓴다(§4.9·§7).
  status?: string;
};

export type SchemaRef = {
  schema_key: string;
  schema_name: string;
  rev?: number;
};

export type FieldRef = {
  key: string;
  name: string;
  type?: string | null;
  unit?: string | null;
};

export type RegionRef = {
  sheet_id: string;
  sheet_name: string;
  range: string;
};

export type ApplicationState = "approved" | "review" | "failed" | "pending";
export type Compatibility =
  | "identical"
  | "compatible"
  | "incompatible"
  | "manual";

export type DocumentProfile = ProfileRef & {
  application_id: string;
  state: ApplicationState | string;
  compatibility: Compatibility | string;
};

export type DocumentRow = {
  document_id: string;
  document_name: string;
  provider: string;
  file_type: string;
  status: DocumentStatus;
  // 서버는 상태 근거를 객체로 준다({applications, unapproved, inherited, failed[], incompatible[], locked{code}}); 문자열도 허용.
  status_detail: DocumentStatusDetail | string | null;
  current_snapshot: SnapshotRef | null;
  profiles: DocumentProfile[];
  schemas: SchemaRef[];
  // 이 문서를 대표 문서로 삼은 파싱 프로파일(§4.13 — 지우면 초안으로 내려간다). 삭제 확인이 미리 알린다.
  // 현재 snapshot만이 아니라 그 문서의 모든 snapshot을 본다(삭제가 지우는 범위와 같다).
  reference_of?: { profile_id: string; profile_name: string }[];
  last_processed_at: string | null;
  last_error: string | null;
};

// GET /documents/{id} — 목록 행과 같은 필드에 이력용 요약이 더해질 수 있다.
export type DocumentDetail = DocumentRow & {
  snapshots?: SnapshotRef[];
  sheet_count?: number;
};

export type SheetRow = {
  sheet_id: string;
  sheet_name: string;
  ordinal: number;
  visibility?: string;
  estimated_rows?: number | null;
  estimated_cols?: number | null;
  roles?: string[];
};

export type SourceEntry = {
  name: string;
  source_ref: string;
  directory: boolean;
  size?: number | null;
  modified_at?: string | null;
};

// 폴더 일괄 등록(§4.1.1)의 파일 분류. provider가 local-xlsx가 아니면 registered(항상 다시 읽는다).
export type SourceScanState = "new" | "changed" | "unchanged" | "locked" | "registered";

export const SCAN_STATE_LABELS: Record<string, string> = {
  new: "새 파일",
  changed: "변경된 문서",
  unchanged: "변경 없음",
  locked: "잠김",
  registered: "등록됨",
};
export const SCAN_STATE_CLASS: Record<string, ChipClass> = {
  new: "ok",
  changed: "warn",
  unchanged: "muted",
  locked: "err",
  registered: "muted",
};

export type SourceSkipped = {
  temp: number;
  unsupported: number;
  symlink: number;
};

// GET /sources/scan?directory= (§4.1.1). files는 대상 확장자 파일 수, targeted는 include_unchanged=false 기준 등록 대상 수.
export type SourceScan = {
  directory: string;
  folders: number;
  files: number;
  states: { new: number; changed: number; unchanged: number; locked: number; registered?: number };
  skipped: SourceSkipped;
  targeted: number;
  limit: number;
  sample: { source_ref: string; state: SourceScanState | string }[];
};

export type RegisterDocument = {
  document_id: string;
  document_name: string;
  snapshot: SnapshotRef | null;
  status: DocumentStatus;
  applied: { profile_name: string; compatibility: string; state: string }[];
  error?: { code: string; message: string } | null;
  // 폴더 일괄 등록에서만 채워진다(§4.1.1 결과 행).
  source_ref?: string;
  state?: SourceScanState | string;
};

// POST /documents/register-directory 결과 요약(§4.1.1). 요약은 documents가 잘려도 항상 전체 기준이다.
export type RegisterSummary = {
  found: number;
  targeted: number;
  registered: number;
  new: number;
  changed: number;
  unchanged: number;
  failed: number;
  locked: number;
  skipped: SourceSkipped;
};

export type RegisterResult = {
  documents: RegisterDocument[];
  // 아래 세 값은 폴더 일괄 등록 결과에만 있다.
  directory?: string;
  summary?: RegisterSummary;
  truncated?: boolean;
};

// 결과 요약 줄(§7 · §4.1.1): "N개 중 R개 등록 · U개 변경 없음 · F개 실패"(+ 잠김이 있으면 덧붙인다).
// 등록 대화상자와 작업 내역의 '결과/오류' 열이 같은 문구를 쓴다(잘린 documents 길이를 세지 않는다).
export function registerSummaryText(summary: RegisterSummary): string {
  const base = `${summary.targeted}개 중 ${summary.registered}개 등록 · ${summary.unchanged}개 변경 없음 · ${summary.failed}개 실패`;
  return summary.locked ? `${base} · ${summary.locked}개 잠김` : base;
}

// ---------------------------------------------------------------- 문서 삭제(§4.13)

// 실제로 지운 행 수. 시트·영역·리비전·값 영역·서명은 이 다섯에 딸린 것이라 세지 않는다.
export type DocumentDeleteCounts = {
  snapshots: number;
  applications: number;
  mappings: number;
  runs: number;
  values: number;
};

export type DocumentDeleteRow = {
  document_id: string;
  // 이름을 알 수 없는 실패 행(없는 id)은 null이다.
  document_name: string | null;
  source_ref: string | null;
  deleted: DocumentDeleteCounts;
  source_removed: boolean;
  // 원본 파일을 지우려 했으나 못 지운 경우에만 온다(문서 삭제 자체는 성공이다).
  source_error?: { code: string; message: string } | null;
  // 렌더 캐시를 지우지 못한 경우에만 온다 — 지운 문서의 셀 내용 파생물이 디스크에 남았다(§4.13).
  render_error?: { code: string; message: string } | null;
  // 이 행의 문서 삭제가 실패했을 때만 온다(summary.failed에 센다).
  error?: { code: string; message: string } | null;
};

// DELETE /documents/{id} 200 · POST /documents/delete 작업의 result — 두 경로가 같은 형태다.
export type DocumentDeleteResult = {
  documents: DocumentDeleteRow[];
  profiles_reset: { profile_id: string; profile_name: string }[];
  summary: { requested: number; deleted: number; failed: number };
};

export const sourceRemovedCount = (result: DocumentDeleteResult): number =>
  (result.documents ?? []).filter((d) => d.source_removed).length;
export const sourceFailedCount = (result: DocumentDeleteResult): number =>
  (result.documents ?? []).filter((d) => !d.source_removed && d.source_error).length;
export const renderFailedCount = (result: DocumentDeleteResult): number => (result.documents ?? []).filter((d) => d.render_error).length;

// 결과 요약(§7 · §4.13): 첫 줄은 언제나, 나머지는 해당할 때만. 토스트와 대화상자가 같은 문구를 쓴다.
export function deleteSummaryLines(result: DocumentDeleteResult): string[] {
  const lines = [`문서 ${result.summary?.deleted ?? 0}개를 지웠습니다.`];
  const removed = sourceRemovedCount(result);
  const failedSource = sourceFailedCount(result);
  if (removed) lines.push(`원본 파일 ${removed}개도 지웠습니다.`);
  if (failedSource) lines.push(`원본 파일 ${failedSource}개는 지우지 못했습니다.`);
  const failedRender = renderFailedCount(result);
  if (failedRender) lines.push(`문서 ${failedRender}개의 렌더 캐시를 지우지 못했습니다 — 서버를 다시 시작하면 회수합니다.`);
  if (result.summary?.failed) lines.push(`실패 ${result.summary.failed}건`);
  if (result.profiles_reset?.length)
    lines.push(`파싱 프로파일 ${result.profiles_reset.length}개가 초안으로 내려갔습니다 — 대표 문서를 다시 지정해 승인하세요.`);
  return lines;
}

// ---------------------------------------------------------------- 프로파일

export type ProfileStatus = "draft" | "approved" | "deprecated";
export const PROFILE_STATUS_LABELS: Record<ProfileStatus, string> = {
  draft: "초안",
  approved: "승인",
  deprecated: "폐기",
};
export const PROFILE_STATUS_CLASS: Record<ProfileStatus, ChipClass> = {
  draft: "warn",
  approved: "ok",
  deprecated: "muted",
};

export type ProfileRow = {
  profile_id: string;
  profile_name: string;
  current_rev: number;
  schema: { key: string; name: string };
  status: ProfileStatus;
  document_count: number;
  success_rate: number | null;
  updated_at: string;
};

export type RuleRow = {
  rule_key: string;
  rule_name: string;
  field: FieldRef | null;
  selector_summary: string;
  value_spec: Record<string, unknown>;
  status: string;
};

export type ProfileDetail = ProfileRow & {
  description: string | null;
  reference: {
    application_id: string;
    document_id: string;
    document_name: string;
    snapshot: SnapshotRef;
    approved_at: string;
    profile_rev: number;
  } | null;
  auto_approval_active: boolean;
  sheet_roles: Record<string, unknown>;
  rules: RuleRow[];
};

export type ProfileDocumentRow = {
  document_id: string;
  document_name: string;
  snapshot: { snapshot_id: string; revision_no: number; captured_at?: string };
  application_id: string;
  profile_rev: number;
  compatibility: Compatibility | string;
  heads_approved: number;
  heads_total: number;
  published: boolean;
  is_reference: boolean;
  // §6: `state`는 application 상태 어휘, `document_status`는 문서 상태. (구 픽스처의 `status`도 문서 상태로 받는다.)
  state?: string;
  document_status?: DocumentStatus;
  status?: DocumentStatus;
};

// 정의 파일 리비전(프로파일·스키마 변경 이력).
// GET /schemas/{key}/revisions · GET /profiles/{id}/revisions — 정의 파일 목록(§7).
// 작성자·요약은 정의 파일에 없으므로 서버가 보내지 않는다. 화면도 그 열을 두지 않는다.
export type RevisionRow = {
  rev: number;
  current?: boolean;
  created_at: string;
  byte_size?: number;
  rule_count?: number;
  field_count?: number;
  description?: string | null;
  profile_name?: string | null;
};

export type ProfileImportPreview = {
  format_detected: string;
  canonical: Record<string, unknown>;
  warnings: string[];
  errors: string[];
};

export type ProfileSaveResult = ProfileDetail & {
  report?: { format_detected: string; warnings: string[] };
};

// §4.7 프로파일 테스트 결과(저장 없음).
export type TestGroup = {
  rule_key: string;
  field: FieldRef | null;
  observed_key: string | null;
  regions: (RegionRef & { role: string })[];
  values: { value_text: string; display_text?: string; unit_normalized?: string | null; region?: RegionRef }[];
  count: number;
};
export type TestResult = {
  bindings: Record<string, string[]>;
  compatibility: Compatibility | string;
  match_signature?: string;
  groups: TestGroup[];
  errors: { code: string; message: string; rule_key?: string }[];
};

// ---------------------------------------------------------------- 스키마

export type SchemaRow = {
  schema_key: string;
  schema_name: string;
  current_rev: number;
  status?: string;
  field_count: number;
  profile_count: number;
  document_count: number;
  // 적용 기록 수 — 스키마 삭제가 막히는 기준(§4.2.1). 목록 응답에는 없고 상세에만 있다.
  application_count?: number;
  updated_at?: string;
};

export type SchemaDetail = SchemaRow & { description?: string | null };

// POST /schemas 201 · PUT /schemas/{key} 200 (§6 B).
export type SchemaSaveResult = {
  schema_key: string;
  schema_name: string;
  current_rev: number;
  unchanged: boolean;
  fields: { total: number; added: number; updated: number; deprecated: number };
};

// DELETE /schemas/{key} 200.
export type SchemaDeleteResult = {
  schema_key: string;
  schema_name: string;
  deleted: { fields: number; aliases: number; edges: number; revisions: number };
  // 정의 파일을 지우지 못했을 때만 온다(작업 공간의 schemas/<key>/에는 이미 없다).
  leftover_path?: string;
};

// DELETE /schemas/{key}/fields/{field_key} 200.
export type FieldDeleteResult = {
  schema_key: string;
  field_key: string;
  name: string;
  current_rev: number;
  fields_remaining: number;
};

export type SchemaTreeNode = {
  field_key: string;
  name: string;
  level: number;
  type?: string | null;
  unit?: string | null;
  status?: string;
  children: SchemaTreeNode[];
};

export type SchemaTree = {
  schema_key: string;
  schema_name: string;
  current_rev: number;
  nodes: SchemaTreeNode[];
};

export type SchemaGraphNode = {
  field_key: string;
  name: string;
  level: number;
  type: string | null;
  parents: string[];
  document_count: number;
  profile_count: number;
};
export type SchemaGraphEdge = { from: string; to: string; relation: string };
export type SchemaGraph = { nodes: SchemaGraphNode[]; edges: SchemaGraphEdge[] };

export type FieldDetail = {
  field_key: string;
  name: string;
  description: string | null;
  type: string | null;
  unit: string | null;
  aliases: string[];
  parents: string[];
  children: string[];
  related: string[];
  profile_count: number;
  document_count: number;
  status: string;
  // POST·PATCH·GET 필드 상세 공용: 저장 뒤 rev는 스키마의 current_rev다(§6 B).
  schema?: { key: string; name: string; rev: number };
};

export type FieldValueRow = {
  text: string;
  value_id: string;
  sheet_id: string;
  sheet_name: string;
  range: string;
  application_id: string;
  rule_key: string;
  document_id: string;
  document_name: string;
  captured_at: string;
};

export type SchemaProfileRow = {
  profile_id: string;
  profile_name: string;
  current_rev: number;
  status: ProfileStatus;
  rules: { count: number; keys: string[] };
  document_count: number;
};

export type SchemaDocumentRow = {
  document_id: string;
  document_name: string;
  profile: ProfileRef;
  snapshot: SnapshotRef;
  status: DocumentStatus;
  application_id: string;
};

// ---------------------------------------------------------------- 검수(적용·매핑·값)

export type MappingRegion = RegionRef & { role: "key" | "value" | "unit" | "context" | string };

export type MappingValue = {
  value_id: string;
  value_text: string;
  display_text: string;
  unit_normalized: string | null;
  value_type: string;
  value_state: string;
  count: number;
  first_region: RegionRef | null;
};

export type MappingStatus = "proposed" | "approved" | "rejected";

export type MappingRow = {
  mapping_id: string;
  rule_key: string;
  rule_name: string;
  field: FieldRef | null;
  observed_key: string | null;
  status: MappingStatus | null;
  origin: string;
  effective_spec: Record<string, unknown>;
  regions: MappingRegion[];
  revision_no: number;
  edit_seq: number;
  value: MappingValue | null;
};

export type MappingRevisionRow = Omit<MappingRow, "value" | "edit_seq"> & {
  mapping_revision_id: string;
  evidence: Record<string, unknown> | null;
  reason: string | null;
  created_by: string | null;
  created_at: string;
};

export type ApplicationRow = {
  application_id: string;
  origin: "auto" | "manual" | "inherited" | string;
  compatibility: Compatibility | string;
  published: boolean;
  heads_approved: number;
  heads_total: number;
  document: { document_id: string; document_name: string };
  snapshot: SnapshotRef;
  profile: ProfileRef;
  schema: SchemaRef;
  state?: ApplicationState | string;
};

// GET /applications/{aid} — Source Review 진입용 집계(요청 1회).
export type ApplicationSummary = ApplicationRow & {
  sheets: (SheetRow & { roles: string[] })[];
  mappings: MappingRow[];
};

// GET /snapshots/{sid}/values · GET /applications/{aid}/values 행(값 + 원본 위치 + application/rule).
export type ValueRow = {
  value_id: string;
  application_id: string;
  rule_key: string;
  rule_name?: string;
  field: FieldRef | null;
  profile?: ProfileRef | null;
  record_key?: string | null;
  value_text: string;
  display_text?: string | null;
  unit_normalized?: string | null;
  value_type?: string;
  value_state?: string;
  count?: number;
  first_region: RegionRef | null;
  captured_at?: string;
};

// ---------------------------------------------------------------- 렌더 창(§5)

export type Area = { r1: number; c1: number; r2: number; c2: number };

// 행·열 목록은 캐시 범위 전체(≤2,000행·≤200열), 원점 0에서 누적한 px 좌표. index는 1부터(A1 = 행 1·열 1).
export type RenderRow = { index: number; y: number; height: number; hidden?: boolean };
export type RenderColumn = { index: number; x: number; width: number; hidden?: boolean };

export type RenderStyle = {
  bg?: string | null;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right" | string;
  valign?: string;
  font_size?: number | null;
  wrap?: boolean;
  border?: string | null;
  number_format?: string | null;
};

export type RenderCell = Area & {
  text: string;
  // styles[] 색인 또는 인라인 스타일.
  style?: number | RenderStyle | null;
  type?: string | null;
  clipped?: boolean;
};

export type RenderImage = {
  asset_id: string;
  url: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  anchor?: Area | null;
};

export type RenderWindow = {
  renderer_version: string;
  sheet: { sheet_id: string; sheet_name: string };
  range: string;
  rows: RenderRow[];
  columns: RenderColumn[];
  width: number;
  height: number;
  estimated_rows: number;
  estimated_cols: number;
  truncated: boolean;
  rendered_bounds: string;
  freeze?: { rows: number; cols: number } | null;
  styles: RenderStyle[];
  cells: RenderCell[];
  merges: Area[];
  images: RenderImage[];
};

export type RenderPending = {
  status: "queued" | "rendering";
  job_id?: string;
  position?: number;
};

export type RenderFailed = {
  status: "failed";
  error: { code: string; message: string };
  retry_after: number;
};

// ---------------------------------------------------------------- 작업·큐

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export const JOB_STATE_LABELS: Record<JobState, string> = {
  queued: "대기",
  running: "진행 중",
  succeeded: "완료",
  failed: "실패",
  cancelled: "취소됨",
};
export const JOB_KIND_LABELS: Record<string, string> = {
  register: "등록",
  extract: "추출",
  reparse: "재파싱",
  build: "빌드",
  test: "테스트",
  queue_action: "묶음 처리",
  delete: "삭제",
};

export type JobResponse = {
  job_id: string;
  kind: string;
  state: JobState;
  completed: number;
  total: number | null;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  target_kind: string | null;
  target_id: string | null;
  label: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type QueueKind = "unmatched" | "review" | "failed" | "changed" | "conflict";
export const QUEUE_LABELS: Record<QueueKind, string> = {
  unmatched: "신규 양식",
  review: "매핑 검수",
  failed: "파싱 실패",
  changed: "변경 감지",
  conflict: "충돌",
};
export type QueueAction =
  | "create_profile"
  | "assign_profile"
  | "open_review"
  | "approve_all"
  | "reparse";

export type QueueGroup = {
  group_key: string;
  kind: QueueKind;
  cause: string;
  label: string;
  count: number;
  impact: { documents: number; rules?: string[]; fields?: string[] };
  representative: {
    document_id: string;
    document_name: string;
    snapshot_id: string;
    application_id?: string | null;
    profile_id?: string | null;
  };
  actions: QueueAction[];
};

// GET /queues는 §4.11 `summary`(큐별 문서 수)를 준다. `counts`는 화면 낙관적 갱신·기존 픽스처가 쓰는 같은 표.
export type QueueSummary = {
  summary?: Record<QueueKind, number>;
  counts?: Record<QueueKind, number>;
  groups?: Partial<Record<QueueKind, QueueGroup[]>>;
};
export const queueCounts = (data: QueueSummary | null | undefined): Record<QueueKind, number> | undefined => data?.counts ?? data?.summary;

export type QueueActionResult = {
  queued: number;
  skipped: { document_id: string; document_name: string; reason: string }[];
};

// ---------------------------------------------------------------- 데이터 빌드(§4.10)

export type BuildReason = "unmatched" | "review_required" | "failed" | "not_extracted" | "locked";
export const BUILD_REASON_LABELS: Record<BuildReason, string> = {
  unmatched: "프로파일 없음",
  review_required: "검수 필요",
  failed: "파싱 실패",
  not_extracted: "재추출 필요",
  locked: "잠김(DRM)",
};

export type BuildCandidate = {
  document_id: string;
  document_name: string;
  usable: boolean;
  reason?: BuildReason | null;
  profile?: ProfileRef | null;
};

export type BuildField = {
  field_key: string;
  name: string;
  type: string | null;
  unit: string | null;
  document_count: number;
};

export type BuildCandidates = {
  documents: BuildCandidate[];
  summary: { total: number; usable: number; excluded: number };
  fields: BuildField[];
};

export type BuildColumn = { field_key: string; header: string; target_unit?: string | null };
export type RowMode = "record" | "document";
export type BuildFormat = "csv" | "xlsx" | "sqlite";

export type PreviewCell = {
  text: string;
  value_id: string | null;
  sheet_id: string | null;
  sheet_name: string | null;
  range: string | null;
  application_id: string | null;
  rule_key: string | null;
} | null;

export type BuildConflict = {
  document_id: string;
  document_name: string;
  field_key: string;
  values: string[];
  reason?: string;
};

// 미리보기 행: 백엔드(build.py _Assembler.rows)는 {row_no, document, snapshot, record_key, cells[]}를 주고, 셀 배열만 오는 형태도 받는다.
export type PreviewRow = {
  row_no?: number;
  document?: { document_id: string; document_name: string } | null;
  snapshot?: { snapshot_id: string; captured_at: string | null } | null;
  record_key?: string | null;
  cells: PreviewCell[];
};

export type BuildPreview = {
  columns: BuildColumn[];
  rows: (PreviewRow | PreviewCell[])[];
  row_count: number;
  excluded: BuildCandidate[];
  conflicts: BuildConflict[];
};

export type BuildManifest = {
  build_key: string;
  created_at: string;
  schema: { key: string; rev: number };
  sources: {
    document_id: string;
    document_name: string;
    snapshot_id: string;
    application_id: string;
    run_id: string;
    profile: { id: string; name: string; rev: number };
  }[];
  columns: (BuildColumn & { type: string | null; unit: string | null })[];
  row_mode: RowMode;
  row_count: number;
  excluded: BuildCandidate[];
  conflicts: BuildConflict[];
};

export type BuildRequest = {
  document_ids: string[];
  schema_key: string;
  columns: BuildColumn[];
  row_mode: RowMode;
  format: BuildFormat;
};

export type BuildResult = {
  build_key: string;
  download_url: string;
  manifest: BuildManifest;
};

// ---------------------------------------------------------------- 공통

export type SearchKind = "document" | "profile" | "schema" | "field";
export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  document: "문서",
  profile: "파싱 프로파일",
  schema: "파싱 스키마",
  field: "필드",
};

export type SearchHit = {
  kind: SearchKind;
  id: string;
  label: string;
  sublabel: string | null;
  // "?screen=documents&document=…" 형식의 쿼리 문자열 또는 파라미터 객체.
  route: string | Record<string, string>;
};

export type StatusResponse = {
  version: string;
  workspace: string;
  render: {
    mode: "http" | "inprocess";
    url: string | null;
    queue_depth: number;
    rendering: number;
  };
  counts: {
    documents: number;
    profiles: number;
    schemas: number;
    jobs_running: number;
    review: number;
  };
};

// GET /settings (§6 B) — 사용자 접근 토큰 관련 키는 없다(메인 API는 인증하지 않는다).
export type ReaderDrmSettings = {
  available: boolean;
  temp_dir_ok?: boolean;
  ttl_seconds?: number;
  cache_mb?: number;
  magics?: number;
};

export type ReaderSettings = {
  factory: string | null;
  revision?: string | null;
  timeout_seconds?: number;
  memory_mb?: number;
  drm?: ReaderDrmSettings;
};

export type SettingsResponse = {
  version?: string;
  workspace: string;
  principal?: string | null;
  engine_version?: string;
  renderer_version?: string;
  render: { mode: string; url: string | null; renderer_version?: string };
  reader?: ReaderSettings;
  limits: Record<string, number | string>;
  paths?: Record<string, string>;
  [key: string]: unknown;
};

export type NormalizationPreset = {
  id: string;
  label: string;
  normalization: Record<string, unknown>;
};

// 큐 묶음 멤버(GET /queues/{kind}/groups/{group_key}/members) — 계약에 열 정의가 없어 여기서 고정한다.
// §4.11 멤버 행: {snapshot_id, state(큐 종류), document_status, application_state, detail{error?…}} + 서버가 붙이는 snapshot 객체.
export type QueueMemberRow = {
  document_id: string;
  document_name: string;
  snapshot_id?: string | null;
  snapshot?: SnapshotRef | null;
  state?: string;
  document_status?: DocumentStatus | string;
  application_state?: string | null;
  detail?: { error?: string | null; [key: string]: unknown };
  application_id?: string | null;
  profile_id?: string | null;
  profile_name?: string | null;
  compatibility?: string | null;
  // 이전 형태(status·error) 호환.
  status?: DocumentStatus | string;
  error?: string | null;
};

// ---------------------------------------------------------------- 화면 공용 라벨 표(§7: 모든 화면이 같은 문구·칩 색을 쓴다)

// 프로파일 적용 호환성(문서 등록 결과·프로파일 상세·Source Review·검수 큐 공용).
export const COMPATIBILITY_LABELS: Record<string, string> = {
  identical: "동일",
  compatible: "호환",
  manual: "수동",
  incompatible: "불일치",
};
export const compatibilityLabel = (value: string | null | undefined): string =>
  value ? COMPATIBILITY_LABELS[value] || value : "-";

// 프로파일 적용(application) 상태 — 문서 상세 '적용 프로파일' 표 등.
export const APPLICATION_STATE_LABELS: Record<string, string> = {
  published: "발행",
  approved: "승인",
  review: "검수 필요",
  changed: "변경 감지",
  extracting: "추출 중",
  pending: "대기",
  failed: "실패",
};
export const APPLICATION_STATE_CLASS: Record<string, ChipClass> = {
  published: "ok",
  approved: "ok",
  review: "warn",
  changed: "warn",
  extracting: "muted",
  pending: "muted",
  failed: "err",
};

// ---------------------------------------------------------------- 재파싱(§4.9)

// POST /applications/{aid}/reparse 작업 결과(적용 건 하나를 현재 프로파일 리비전으로 다시 맞추고 추출한 결과).
// 판정은 프로파일 전체 재파싱과 같은 규칙이므로 사유 코드도 같다.
export type ApplicationReparse = {
  application_id: string;
  document_id: string;
  document_name: string;
  profile: { id: string; name: string; rev: number };
  // 처리됨 / 건너뜀.
  outcome: string;
  // 건너뛴 사유 코드(처리됐으면 없다).
  reason?: string | null;
  // 어느 쪽을 했는지: rematch = 현재 리비전으로 다시 맞추고 추출, extract = 매칭은 그대로 두고 값만 다시 뽑음.
  action?: "rematch" | "extract" | string;
  // 추출은 실패해도 작업은 성공으로 끝난다(실패는 실행 행에 남는다) — state가 succeeded가 아니면 error가 온다.
  extraction?: { run_id: string; state: string; values: number; error?: { code: string; message: string } | null } | null;
};

// outcome은 두 값(처리됨·건너뜀)뿐이다. 코드로 오든 우리말로 오든 같게 읽는다.
const REPARSE_PROCESSED = ["processed", "처리됨", "extracted", "queued"];
const REPARSE_SKIPPED = ["skipped", "건너뜀"];
export const isReparseProcessed = (outcome: string | null | undefined): boolean => !!outcome && REPARSE_PROCESSED.includes(outcome);
export const isReparseSkipped = (outcome: string | null | undefined): boolean => !!outcome && REPARSE_SKIPPED.includes(outcome);

// 재파싱이 건너뛴 사유를 사람 말로. 프로파일 전체 재파싱(skipped[].reason)과 한 건 재파싱(reason)이 같은 코드를 쓴다.
// 모르는 코드는 코드를 그대로 보여 준다 — 문구가 없다고 화면이 비지 않게.
export const REPARSE_REASON_LABELS: Record<string, string> = {
  // 이 갈래는 원본 파일을 **읽지 않고** 판정한다(적용 건이 이미 현재 리비전이고 발행돼 있다) —
  // 그래서 '원본이 바뀌었으면 다시 등록하라'까지 말해 준다. 그 말이 없으면 낡은 원본을 최신으로 오해한다.
  up_to_date: "이미 최신입니다 — 다시 뽑을 것이 없습니다. 원본 파일이 바뀌었으면 문서를 다시 등록하세요",
  review_required: "검수가 필요합니다 — 검수 화면에서 승인하세요",
  incompatible: "이 프로파일과 구조가 맞지 않습니다",
  published: "이미 발행된 결과라 그대로 두었습니다",
  deleted: "문서가 이미 지워졌습니다",
  PROFILE_NOT_APPROVED: "승인된 프로파일이 아닙니다",
  PROFILE_DEPRECATED: "폐기된 프로파일입니다 — 적용 기록은 그대로 둡니다",
  ACCESS_DENIED: "이 원본에 접근할 권한이 없습니다",
  SOURCE_NOT_FOUND: "원본 파일을 찾을 수 없습니다",
  SOURCE_VERSION_CHANGED: "원본이 바뀌었습니다. 문서를 다시 등록하세요",
  SOURCE_SIZE_LIMIT: "원본이 너무 커서 읽을 수 없습니다",
  EXPANDED_SIZE_LIMIT: "원본이 너무 커서 읽을 수 없습니다",
  SHEET_LIMIT: "시트 수가 Reader 한도를 넘었습니다",
  READER_TIMEOUT: "문서 읽기 제한 시간을 넘었습니다",
  READER_STOPPED: "문서 읽기 프로세스가 끝나 버렸습니다",
  READER_MEMORY_LIMIT: "문서 읽기 메모리 한도를 넘었습니다",
  READER_FAILED: "문서를 읽지 못했습니다 — 제공자 설정과 문서 형식을 확인하세요",
  DRM_READER_REQUIRED: "보호 문서를 읽을 Reader가 설정되지 않았습니다 — 설정 화면에서 연결하세요",
  DRM_OPEN_FAILED: "보호 문서를 열지 못했습니다",
  DRM_OPEN_TIMEOUT: "보호 문서를 여는 데 시간이 너무 걸렸습니다",
  DRM_TEMP_UNSAFE: "보호 문서를 열 임시 폴더가 안전하지 않습니다",
};
export const reparseReasonLabel = (value: string | null | undefined): string =>
  value ? REPARSE_REASON_LABELS[value] || value : "";
