export interface SourceInfo {document_id: string; document_version: string; sheet: string; a1_range: string; concept_id?: string; parsing_template?: {template_id: string; template_version: number; status: string}; template_source?: {range?: string}; effective_source?: {range?: string}; mapping_source?: string}
export function SourceInspector({source}: {source: SourceInfo | null}) {
  return <aside className="inspector"><header><span>Source Inspector</span><b>READ ONLY</b></header>{source ? <dl>
    <dt>Document</dt><dd>{source.document_id}</dd><dt>Document Version</dt><dd className="mono">{source.document_version}</dd>
    <dt>Sheet</dt><dd>{source.sheet}</dd><dt>Range</dt><dd className="range">{source.a1_range}</dd>
    <dt>Concept</dt><dd>{source.concept_id || "—"}</dd><dt>Parsing Template</dt><dd>{source.parsing_template ? `${source.parsing_template.template_id} v${source.parsing_template.template_version}` : "—"}</dd>
    <dt>Mapping Source</dt><dd>{source.mapping_source || "TEMPLATE"}</dd>
    {source.template_source && <><dt>Template Source</dt><dd>{source.template_source.range}</dd></>}
    {source.effective_source && <><dt>Effective Source</dt><dd>{source.effective_source.range}</dd></>}
  </dl> : <p className="muted">KG에서 Source를 선택하면 문서 버전, Sheet, Range와 Parsing Template 근거가 표시됩니다.</p>}</aside>;
}
