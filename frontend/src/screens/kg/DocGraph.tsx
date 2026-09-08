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
  // 개념은 생략 없이 전부 그린다 — 한 줄 6개씩 줄바꿈, hull이 세로로 늘어난다
  const COLS = 6, NODEW = 128, ROWH = 57, W = 1180;
  const concepts = g.domain_node_ids;
  const rows = Math.max(1, Math.ceil(concepts.length / COLS));
  const nx = (i: number) => 70 + (i % COLS) * (NODEW + 40);
  const ny = (i: number) => 105 + Math.floor(i / COLS) * ROWH;
  const usedCols = Math.min(Math.max(concepts.length, 1), COLS);
  const hullW = Math.max(nx(usedCols - 1) + NODEW + 30 - 40, 460);
  const hullH = 130 + (rows - 1) * ROWH;
  const hullMid = 40 + hullW / 2;
  const hullBot = 55 + hullH;          // 아래 섹션들은 hull 높이에 맞춰 내려간다

  const groups = templateGroups(g).filter((grp) => !(grp.isEtc && !grp.docs.length));
  const TW = 250, TH = 84;
  const tx = (i: number) => 60 + i * (TW + 40);
  const ty = hullBot + 125;
  const H = ty + TH + 60;

  return (
    <svg className="graphSvg" viewBox={`0 0 ${W} ${H}`}
      style={{ width: `${zoom * 100}%`, height: (H + 20) * zoom }}
      aria-label="문서군, 템플릿, 문서 개수">
      {/* 문서군[개념] — 커버하는 개념 노드들을 감싼 hull */}
      <rect x={40} y={55} width={hullW} height={hullH} rx={20}
        className="hull" style={{ fill: `${color}10`, stroke: color }} />
      <text x={58} y={84} fontSize={15} fontWeight={800} fill={color}>
        {g.name} · 개념 {concepts.length}</text>
      {concepts.map((nid, i) => (
        <g key={nid}>
          <rect className="docNode" x={nx(i)} y={ny(i)} width={NODEW} height={45} rx={10} />
          <text className="ntext" x={nx(i) + NODEW / 2} y={ny(i) + 22}>{nameOf[nid] || nid}</text>
        </g>
      ))}

      {/* 문서군 → 템플릿 엣지 */}
      {groups.map((grp, i) => (
        <path key={`e-${grp.label}`} className="gedge"
          d={`M${hullMid} ${hullBot} C ${hullMid} ${hullBot + 55}, ${tx(i) + TW / 2} ${ty - 45}, ${tx(i) + TW / 2} ${ty}`} />
      ))}

      <text x={60} y={ty - 20} fontSize={12} fill="#6e7685" fontWeight={700}>
        TEMPLATES (파싱 스크립트 기준 분류)</text>
      {groups.map((grp, i) => {
        const sel = selectedTpl === grp.label;
        return (
          <g key={grp.label} style={{ cursor: "pointer" }}
            onClick={() => onSelectTemplate(grp.label)}>
            <rect className={`docFile${sel ? " sel" : ""}`}
              x={tx(i)} y={ty} width={TW} height={TH} rx={11}
              style={grp.isEtc ? { strokeDasharray: "6 5" } : { stroke: "var(--purple)" }} />
            <text x={tx(i) + 16} y={ty + 28} fontSize={13} fontWeight={700}
              fill={grp.isEtc ? "#6e7685" : "#7b61c9"}>
              ▣ {grp.label.slice(0, 24)}{grp.label.length > 24 ? "…" : ""}</text>
            <text x={tx(i) + 16} y={ty + 56} fontSize={15} fontWeight={800}>
              문서 {grp.docs.length}개</text>
            {grp.review ? (
              <text x={tx(i) + 16} y={ty + 74} fontSize={11} fill="#b57b1b">
                검토 대기 {grp.review}</text>
            ) : null}
          </g>
        );
      })}
      <text x={60} y={ty + TH + 46} fontSize={12} fill="#6e7685">
        템플릿을 누르면 우측에 문서 목록이 열립니다</text>
    </svg>
  );
}
