export interface TemplateGroup {
  template_id: string; template_name: string; version: number;
  override_documents: number; review_required: number; failed: number;
  documents: {document_id: string; filename: string; status: string; override_count: number}[];
}

export function ParsingTemplatePanel({groups}: {groups: TemplateGroup[]}) {
  if (!groups.length) return <div className="empty-nav"><span>◇</span><strong>Document KG를 선택하세요</strong><p>Parsing Template과 소속 문서가 계층으로 표시됩니다.</p></div>;
  return <div className="template-tree">{groups.map(group => <section key={`${group.template_id}-${group.version}`}>
    <header><i>▣</i><div><strong>{group.template_name} <small>v{group.version}</small></strong><span>{group.documents.length} documents · {group.override_documents} overrides</span></div></header>
    {group.review_required > 0 && <b className="review">검토 필요 {group.review_required}</b>}
    <ul>{group.documents.map(document => <li key={document.document_id}><i>▤</i><span>{document.filename}<small>{document.status}{document.override_count ? ` · override ${document.override_count}` : ""}</small></span></li>)}</ul>
  </section>)}</div>;
}
