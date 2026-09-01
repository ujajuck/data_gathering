// 서버 응답 형태 — kg/webapp.py가 내려주는 그대로. 깊은 필드는 화면에서 쓰는
// 것만 선언하고 나머지는 느슨하게 둔다 (백엔드가 원본 스펙).

export interface DomainNode {
  id: string; name: string; level: string;
  root: string | null; parent: string | null; sources: number;
  // 레이아웃 계산 시 부여 (layoutDomain)
  x?: number; y?: number;
}

export interface DomainKg { domain: string; nodes: DomainNode[] }

export interface DkgSummary {
  id: string; name: string;
  member_document_count: number;
  domain_node_ids: string[];
  source_location_count: number;
  member_document_ids?: string[];
}

export interface DkgMemberDoc {
  document_id: string; filename: string; nodes: string[];
  first_locator?: string; sources: number; override?: string | null;
}

export interface DkgDetailData extends DkgSummary {
  value_count: number;
  member_documents: DkgMemberDoc[];
  recipe: {
    recipe_id: string; template: number; conflicts: number; dropped: number;
    stale_entries?: number; created_at: string;
  } | null;
  parsing_templates?: {
    template_id?: string; template_name: string; version: number | string;
    override_documents: number; review_required: number; failed: number;
    documents: { document_id?: string; filename: string; status: string;
      override_count: number }[];
  }[];
  last_recrawl?: { mode: string; status: string; started_at?: string } | null;
}

export interface Concept { concept_id: string; canonical_name: string }

export interface FileRow {
  document_id: string; filename: string; status: string;
  headers: number; coverage_pct: number; review: number;
  drm_status?: string | null; render_status?: string | null; parsing_status?: string | null;
  author?: string | null; created?: string | null; modified?: string | null;
  template_name?: string | null; template_version?: number | string | null;
}

export interface RawFile {
  filename: string; locked?: boolean; container_detail?: string;
  drm?: { status: string; requested_at?: string; note?: string } | null;
}

export interface RawSuggestion {
  root_concept_id: string; name: string; match_pct: number; has_recipe?: boolean;
}

export interface SearchSource {
  node_id: string; document: string; document_id: string; sheet: string;
  locator: string; rows: number; mapping: string; status: string; header: string;
}

export interface SearchResult {
  concept: { concept_id: string; description?: string };
  documents: unknown[];
  sources: SearchSource[];
  total_rows: number;
}

export interface ReviewRow {
  node_id: string; node_name: string; concept_id: string | null;
  document_id: string; filename: string; locator: string; confidence: number;
  mapping_id?: string;
}

export interface SheetCell {
  r: number; c: number; v?: string; rs?: number; cs?: number;
  f?: string; b?: boolean; i?: boolean; sz?: number; fc?: string;
  ha?: "l" | "c" | "r"; n?: boolean; wr?: boolean;
  bd?: { t?: string; r?: string; b?: string; l?: string };
}

export interface SheetData {
  sheet: string; sheets: string[]; cells: SheetCell[];
  cols: number[]; rows: number[]; max_row: number; max_col: number;
  gridlines?: boolean; truncated?: boolean;
  images?: { src: string; x: number; y: number; w: number; h: number }[];
  shapes?: {
    text?: string;
    x?: number; y?: number; w?: number; h?: number;              // 앵커 px (openpyxl 경로)
    left?: number; top?: number; width?: number; height?: number; // points (COM 경로)
  }[];
  viewer?: { drm_status: string; render_status?: string } | null;
  document_version?: string | null;
}

export interface OverlayItem {
  node_id: string; range?: string; role: string; header?: string; concept_name?: string;
}

export interface SourceDetail {
  range: string; document: string; document_version?: string | null; sheet: string;
  role: string; concept_name?: string | null; header: string; unit?: string | null;
  mapping: {
    mapping_id: string; status: string; confidence: number;
    concept_id: string | null; method?: string; reason?: string;
  } | null;
  row_context: { keys?: string[]; header_path?: string[] };
  viewer?: { drm_status: string; render_status?: string } | null;
  parsing_template?: { template_name: string; template_version: string | number; status: string } | null;
  parsing_source?: {
    mapping_source: string; override_status?: string; override_reason?: string;
    template_source?: { sheet?: string; range?: string } | null;
    effective_source?: { sheet?: string; range?: string } | null;
  } | null;
  values: { key?: string | null; value: string }[];
}

export interface ProposalField {
  field_name: string; concept_id: string; concept_name: string;
  role: string | null; sources: number; note: string; status: string;
  type?: string; target_unit?: string | null; node_ids: string[];
}

export interface Proposal { fields: ProposalField[]; stale_node_ids?: string[] }

export interface BuildResult {
  status: string; table: string; row_count: number;
  lineage: { edges: number; documents: number };
  artifact: string;
  build_report: { warnings: { field?: string; reason?: string; column?: string; from?: string; to?: string; cells?: number }[] };
  schema: { field: string; concept: string; unit?: string | null; included?: boolean }[];
  preview: Record<string, unknown>[];
}

export interface RecrawlDocSummary {
  filename: string; error?: string | null;
  map?: { nodes?: number; REVIEW_REQUIRED?: number } | null;
  ingest?: { skipped?: number; unchanged?: number } | null;
  recipe?: { applied?: number; review?: number; relaxed?: boolean } | null;
}

export interface RecrawlRun { status: string; summary: RecrawlDocSummary[] }

export interface ConceptDetail {
  concept: {
    concept_id?: string; canonical_name?: string; canonical_name_en?: string;
    description?: string; domain_level?: string; data_type?: string;
    canonical_unit?: string; status?: string;
  };
  aliases: string[];
  relations: { source_concept_id: string; target_concept_id: string; relation_type: string }[];
  active_mappings: number;
}
