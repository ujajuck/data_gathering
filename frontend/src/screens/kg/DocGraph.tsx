// 문서군 상세 그래프 — 문서군[개념] → 템플릿(파싱 스크립트 기준 분류) →
// 문서 개수. 개별 문서 카드는 그리지 않는다: 템플릿 상자를 누르면 우측
// 상세 패널에 문서 목록 표가 열린다.
import type { DkgDetailData, DomainKg } from "../../lib/types";
import { templateGroups } from "./templateGroups";

interface Props {
  g: DkgDetailData;
  domain: DomainKg;
  color: string;
  selectedTpl: string | null;
  onSelectTemplate: (label: string) => void;
  zoom?: number;
}

export default function DocGraph({ g, domain, color, selectedTpl,
  onSelectTemplate, zoom = 1 }: Props) {
  const nameOf = Object.fromEntries(domain.nodes.map((n) => [n.id, n.name]));
  const top = g.domain_node_ids.slice(0, 6);
  const NODEW = 128, W = 1180;
  const nx = (i: number) => 70 + i * (NODEW + 40);
  const hullW = Math.max(nx(top.length - 1) + NODEW + 30 - 40, 460);
  const hullMid = 40 + hullW / 2;

  const groups = templateGroups(g).filter((grp) => !(grp.isEtc && !grp.docs.length));
  const TW = 250, TH = 84;
  const tx = (i: number) => 60 + i * (TW + 40);

  return (
    <svg className="graphSvg" viewBox={`0 0 ${W} 500`}
      style={{ width: `${zoom * 100}%`, height: 520 * zoom }}
      aria-label="문서군, 템플릿, 문서 개수">
      {/* 문서군[개념] — 커버하는 개념 노드들을 감싼 hull */}
      <rect x={40} y={55} width={hullW} height={130} rx={20}
        className="hull" style={{ fill: `${color}10`, stroke: color }} />
      <text x={58} y={84} fontSize={15} fontWeight={800} fill={color}>
        {g.name} · 개념 {g.domain_node_ids.length}</text>
      {top.map((nid, i) => (
        <g key={nid}>
          <rect className="docNode" x={nx(i)} y={105} width={NODEW} height={45} rx={10} />
          <text className="ntext" x={nx(i) + NODEW / 2} y={127}>{nameOf[nid] || nid}</text>
        </g>
      ))}
      {g.domain_node_ids.length > top.length && (
        <text x={nx(top.length - 1) + NODEW + 44} y={132} fontSize={12} fill="#6e7685">
          외 {g.domain_node_ids.length - top.length}개 개념</text>
      )}

      {/* 문서군 → 템플릿 엣지 */}
      {groups.map((grp, i) => (
        <path key={`e-${grp.label}`} className="gedge"
          d={`M${hullMid} 185 C ${hullMid} 240, ${tx(i) + TW / 2} 265, ${tx(i) + TW / 2} 310`} />
      ))}

      <text x={60} y={290} fontSize={12} fill="#6e7685" fontWeight={700}>
        TEMPLATES (파싱 스크립트 기준 분류)</text>
      {groups.map((grp, i) => {
        const sel = selectedTpl === grp.label;
        return (
          <g key={grp.label} style={{ cursor: "pointer" }}
            onClick={() => onSelectTemplate(grp.label)}>
            <rect className={`docFile${sel ? " sel" : ""}`}
              x={tx(i)} y={310} width={TW} height={TH} rx={11}
              style={grp.isEtc ? { strokeDasharray: "6 5" } : { stroke: "var(--purple)" }} />
            <text x={tx(i) + 16} y={338} fontSize={13} fontWeight={700}
              fill={grp.isEtc ? "#6e7685" : "#7b61c9"}>
              ▣ {grp.label.slice(0, 24)}{grp.label.length > 24 ? "…" : ""}</text>
            <text x={tx(i) + 16} y={366} fontSize={15} fontWeight={800}>
              문서 {grp.docs.length}개</text>
            {grp.review ? (
              <text x={tx(i) + 16} y={384} fontSize={11} fill="#b57b1b">
                검토 대기 {grp.review}</text>
            ) : null}
          </g>
        );
      })}
      <text x={60} y={440} fontSize={12} fill="#6e7685">
        템플릿을 누르면 우측에 문서 목록이 열립니다</text>
    </svg>
  );
}
