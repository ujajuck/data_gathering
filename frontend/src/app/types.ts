// API 응답·요청 형태 (docs/design/contracts.md §5·§6·§7).
// 화면 표시 규칙(§7): UUID·SHA-256은 URL 파라미터와 API 호출에만 쓰고 화면 텍스트에는 쓰지 않는다.

export type Page<T> = {
  items: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    fields?: Record<string, unknown> | string[];
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
export type RevisionRow = {
  rev: number;
  created_at: string;
  created_by?: string | null;
  summary?: string | null;
  format_detected?: string | null;
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
  updated_at?: string;
};

export type SchemaDetail = SchemaRow & { description?: string | null };

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

export type SettingsResponse = {
  workspace: string;
  render: { mode: string; url: string | null; renderer_version?: string };
  reader_factory: string | null;
  limits: Record<string, number | string>;
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
