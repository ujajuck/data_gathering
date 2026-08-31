// 전체 Domain KG: 루트 → L1 → 리프 트리 위에 Document KG Coverage Hull을
// 겹쳐 그린다 (§3.2 — 고정 좌표 유지). web_kg layoutDomain/renderDomainGraph 포트.
import type { DkgSummary, DomainKg, DomainNode } from "../../lib/types";
import type { SelNode } from "../../lib/store";

interface LaidNode extends DomainNode { x: number; y: number }
interface Group {
  dkg: { id: string; name: string; member_document_count: number };
  l1: DomainNode | undefined;
  nodes: LaidNode[];
  x: number; y: number; w: number; h: number; l1x: number; l1y: number;
}

const NW = 104, NH = 30, GX = 12, GY = 26, PAD = 16, L1H = 34, LABEL = 26;

function layoutDomain(domain: DomainKg, dkgs: DkgSummary[]) {
  const leafs = domain.nodes.filter((n) => n.level !== "L1").map((n) => ({ ...n } as LaidNode));
  const l1s = Object.fromEntries(
    domain.nodes.filter((n) => n.level === "L1").map((n) => [n.id, n]));
  const groups: Group[] = [];
  const order = [...dkgs.map((g) => g.id),
    ...Object.keys(l1s).filter((id) => !dkgs.some((g) => g.id === id))];
  for (const rootId of order) {
    const nodes = leafs.filter((n) => n.root === rootId);
    if (!nodes.length) continue;
    // 부모(L2) 바로 뒤에 자식(L3)이 오도록 정렬 — 계층 엣지가 이웃 칸으로 떨어진다
    const l2 = nodes.filter((n) => n.parent && l1s[n.parent])
      .sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
    const ordered: LaidNode[] = [];
    for (const p of l2) {
      ordered.push(p);
      ordered.push(...nodes.filter((n) => n.parent === p.id));
    }
    for (const n of nodes) if (!ordered.includes(n)) ordered.push(n);
    const found = dkgs.find((g) => g.id === rootId);
    const dkg = found ||
      { id: rootId, name: (l1s[rootId] ? l1s[rootId].name : rootId) + " KG",
        member_document_count: 0 };
    groups.push({ dkg, l1: l1s[rootId], nodes: ordered,
      x: 0, y: 0, w: 0, h: 0, l1x: 0, l1y: 0 });
  }
  let x = 14, y = 96, rowH = 0;
  const MAXW = 1160;
  for (const g of groups) {
    const cols = Math.min(4, Math.max(2, Math.ceil(g.nodes.length / 3)));
    const rows = Math.ceil(g.nodes.length / cols);
    g.w = cols * (NW + GX) - GX + PAD * 2;
    g.h = PAD + L1H + 18 + rows * (NH + GY) - GY + LABEL + PAD;
    if (x + g.w > MAXW) { x = 14; y += rowH + 26; rowH = 0; }
    g.x = x; g.y = y;
    x += g.w + 20; rowH = Math.max(rowH, g.h);
    g.l1x = g.x + g.w / 2;                 // L1 노드 중심
    g.l1y = g.y + PAD;
    g.nodes.forEach((n, i) => {
      n.x = g.x + PAD + (i % cols) * (NW + GX);
      n.y = g.y + PAD + L1H + 18 + Math.floor(i / cols) * (NH + GY);
    });
  }
  const height = y + rowH + 20;
  return { groups, height };
}

interface Props {
  domain: DomainKg;
  dkgs: DkgSummary[];
  selDkg: string | null;
  selNode: SelNode | null;
  dkgColor: (id: string) => string;
  onSelectNode: (id: string) => void;
  onSelectDkg: (id: string) => void;
}

export default function DomainGraph({ domain, dkgs, selDkg, selNode, dkgColor,
  onSelectNode, onSelectDkg }: Props) {
  const { groups, height } = layoutDomain(domain, dkgs);
  const rootX = 590, rootY = 16, ROOTW = 150, ROOTH = 40;
  const nodeAt: Record<string, LaidNode> = {};
  for (const g of groups) for (const n of g.nodes) nodeAt[n.id] = n;

  return (
    <svg className="graphSvg" viewBox={`0 0 1180 ${height}`}
      style={{ height: Math.min(660, height) }}
      aria-label="전체 Domain KG 트리와 Document KG 커버리지">
      {/* Coverage Hull — 트리 가지(L1+리프)를 감싸는 반투명 영역, 라벨은 하단 */}
      {groups.map((g) => {
        const color = dkgColor(g.dkg.id);
        const dim = selDkg && selDkg !== g.dkg.id ? " dim" : "";
        return (
          <g key={`hull-${g.dkg.id}`}>
            <rect className={`hull${dim}`} x={g.x} y={g.y} width={g.w} height={g.h} rx={22}
              style={{ fill: `${color}10`, stroke: color }}
              onClick={() => onSelectDkg(g.dkg.id)} />
            <text className={`hlabel${dim}`} x={g.x + 14} y={g.y + g.h - 12}
              style={{ fill: color }} onClick={() => onSelectDkg(g.dkg.id)}>
              {g.dkg.name} · {g.dkg.member_document_count} docs</text>
          </g>
        );
      })}
      {groups.map((g) => (
        <g key={`edges-${g.dkg.id}`}>
          {/* 루트 → L1 엣지 */}
          <path className="gedge"
            d={`M${rootX + ROOTW / 2} ${rootY + ROOTH} C ${rootX + ROOTW / 2} ${rootY + ROOTH + 26}, ${g.l1x} ${g.l1y - 26}, ${g.l1x} ${g.l1y}`} />
          {/* L1 → 각 리프 팬아웃 (L3는 자기 부모 L2에 연결) */}
          {g.nodes.map((n) => {
            const p = n.parent ? nodeAt[n.parent] : undefined;
            const fromX = p ? p.x + NW / 2 : g.l1x;
            const fromY = p ? p.y + NH : g.l1y + L1H;
            return <line key={n.id} className="gedge"
              x1={fromX} y1={fromY} x2={n.x + NW / 2} y2={n.y} />;
          })}
        </g>
      ))}
      <g>
        <rect className="gnode" x={rootX} y={rootY} width={ROOTW} height={ROOTH} rx={13}
          style={{ stroke: "#8d99ad", strokeWidth: 2 }} />
        <text className="ntext" x={rootX + ROOTW / 2} y={rootY + ROOTH / 2 - 5}>
          {domain.domain || "Domain"}</text>
        <text className="ncnt" x={rootX + ROOTW / 2} y={rootY + ROOTH / 2 + 11}>
          Fixed Domain KG</text>
      </g>
      {groups.map((g) => {
        const color = dkgColor(g.dkg.id);
        const dim = selDkg && selDkg !== g.dkg.id ? " dim" : "";
        const l1sel = selDkg === g.dkg.id ? " sel" : "";
        return (
          <g key={`boxes-${g.dkg.id}`}>
            <g>
              <rect className={`gnode${l1sel}${dim}`} x={g.l1x - 62} y={g.l1y}
                width={124} height={L1H} rx={11} style={{ stroke: color, fill: "#fff" }}
                onClick={() => onSelectDkg(g.dkg.id)} />
              <text className="ntext" x={g.l1x} y={g.l1y + L1H / 2 + 1} style={{ fill: color }}>
                {g.l1 ? g.l1.name : g.dkg.name}</text>
            </g>
            {g.nodes.map((n) => {
              const sel = selNode && selNode.id === n.id ? " sel" : "";
              return (
                <g key={n.id}>
                  <rect className={`gnode${sel}${dim}`} x={n.x} y={n.y}
                    width={NW} height={NH} rx={9} onClick={() => onSelectNode(n.id)} />
                  <text className="ntext" x={n.x + NW / 2} y={n.y + 12}>{n.name}</text>
                  <text className="ncnt" x={n.x + NW / 2} y={n.y + 24}>
                    {n.sources ? `${n.sources} src` : "미연결"}</text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
