// 문서군[개념] → 템플릿(파싱 스크립트 기준 분류) → 문서 그룹 계산.
// 상세 패널(DkgDetailPanel)과 그래프(DocGraph)가 같은 계층을 그리도록 공유한다.
import type { DkgDetailData, DkgMemberDoc } from "../../lib/types";

export const ETC_TPL = "기타 (템플릿 미배정)";

export interface TemplateGroup {
  label: string;
  isEtc: boolean;
  review: number;
  docs: DkgMemberDoc[];
}

export function templateGroups(g: DkgDetailData): TemplateGroup[] {
  const members = g.member_documents || [];
  const templated = new Set<string>();
  const groups: TemplateGroup[] = [];
  for (const t of g.parsing_templates || []) {
    const ids = new Set(t.documents.map((d) => d.document_id).filter(Boolean));
    for (const id of ids) templated.add(id as string);
    groups.push({ label: `${t.template_name} v${t.version}`, isEtc: false,
      review: t.review_required,
      docs: members.filter((d) => ids.has(d.document_id)) });
  }
  const etc = members.filter((d) => !templated.has(d.document_id));
  if (etc.length || !groups.length)
    groups.push({ label: ETC_TPL, isEtc: true, review: 0, docs: etc });
  return groups;
}
