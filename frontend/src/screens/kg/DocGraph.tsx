// Document KG 상세: 커버 노드 + Member Documents (§4). web_kg renderDocGraph 포트.
import type { DkgDetailData, DomainKg } from "../../lib/types";

interface Props {
  g: DkgDetailData;
  domain: DomainKg;
  color: string;
  selDkgDoc: string | null;
  onSelectDoc: (documentId: string) => void;
}

export default function DocGraph({ g, domain, color, selDkgDoc, onSelectDoc }: Props) {
  const nameOf = Object.fromEntries(domain.nodes.map((n) => [n.id, n.name]));
  const top = g.domain_node_ids.slice(0, 6);
  const NODEW = 128, W = 1180;
  const nx = (i: number) => 70 + i * (NODEW + 40);
  const docs = (g.member_documents || []).slice(0, 4);
  const dx = (i: number) => 60 + i * 280;
  return (
    <svg className="graphSvg" viewBox={`0 0 ${W} 500`} style={{ height: 520 }}
      aria-label="Document KG와 소속 문서">
      <rect x={40} y={55}
        width={Math.max(nx(top.length - 1) + NODEW + 30 - 40, 460)} height={130} rx={20}
        className="hull" style={{ fill: `${color}10`, stroke: color }} />
      <text x={58} y={84} fontSize={15} fontWeight={800} fill={color}>{g.name}</text>
      {/* 엣지: 문서 → 제공 노드 */}
      {docs.map((d, di) => top.map((nid, ni) => (
        d.nodes.includes(nameOf[nid]) ? (
          <line key={`${d.document_id}-${nid}`}
            className={`docEdge${selDkgDoc === d.document_id ? " hi" : ""}`}
            x1={nx(ni) + NODEW / 2} y1={150} x2={dx(di) + 110} y2={330} />
        ) : null
      )))}
      {top.map((nid, i) => (
        <g key={nid}>
          <rect className="docNode" x={nx(i)} y={105} width={NODEW} height={45} rx={10} />
          <text className="ntext" x={nx(i) + NODEW / 2} y={127}>{nameOf[nid] || nid}</text>
        </g>
      ))}
      {g.domain_node_ids.length > top.length && (
        <text x={nx(top.length - 1) + NODEW + 44} y={132} fontSize={12} fill="#6e7685">
          외 {g.domain_node_ids.length - top.length}개 노드</text>
      )}
      <text x={60} y={300} fontSize={12} fill="#6e7685" fontWeight={700}>MEMBER DOCUMENTS</text>
      {docs.map((d, i) => (
        <g key={d.document_id} onClick={() => onSelectDoc(d.document_id)}>
          <rect className={`docFile${selDkgDoc === d.document_id ? " sel" : ""}`}
            x={dx(i)} y={330} width={230} height={92} rx={11} />
          <text x={dx(i) + 14} y={355} fontSize={12} fontWeight={700}>
            {d.filename.slice(0, 24)}{d.filename.length > 24 ? "…" : ""}</text>
          <text x={dx(i) + 14} y={376} fontSize={11} fill="#6e7685">
            {(d.first_locator || "").slice(0, 30)}</text>
          <text x={dx(i) + 14} y={396} fontSize={11} fill="#6e7685">
            mapped: {d.nodes.slice(0, 3).join(", ").slice(0, 30)}{d.nodes.length > 3 ? "…" : ""}</text>
          <text x={dx(i) + 14} y={414} fontSize={11} fill="#6e7685">{d.sources} source</text>
        </g>
      ))}
      {(g.member_documents || []).length > docs.length || g.member_document_count > docs.length ? (
        <text x={60} y={470} fontSize={12} fill="#6e7685">
          … 외 {g.member_document_count - docs.length}개 문서 (우측 목록에서 선택)</text>
      ) : null}
    </svg>
  );
}
