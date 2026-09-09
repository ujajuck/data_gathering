// v1 DomainGraph(루트 → L1 → 리프 트리 위에 문서군 Coverage Hull) 이식.
// 좌표 알고리즘은 v1 layoutDomain과 같고, 데이터는 GET /kg/{kg}/graph 응답을 쓴다.
import type { KeyboardEvent } from "react";
import type { Row } from "./client";

export type GraphNode = {
  concept_id: string;
  name: string;
  level: number;
  parent: string | null;
  root: string | null;
  sources: number;
};
export type GraphGroup = {
  root_concept_id: string;
  name: string;
  member_document_count: number;
};
export type Graph = {
  domain: string;
  nodes: GraphNode[];
  groups: GraphGroup[];
  edges: Row[];
  truncated: boolean;
  node_cap?: number;
};
type LaidNode = GraphNode & { x: number; y: number };
export type Laid = {
  group: GraphGroup;
  l1: GraphNode | undefined;
  nodes: LaidNode[];
  x: number;
  y: number;
  w: number;
  h: number;
  l1x: number;
  l1y: number;
};

// v1 lib/api.ts PALETTE와 같은 값. 새 색 체계를 만들지 않는다.
export const GROUP_COLORS = [
  "#3569e8",
  "#7b61c9",
  "#3a8d6d",
  "#b57b1b",
  "#c05b8c",
  "#3d8ea6",
  "#7a7f8a",
];
export const ORPHAN = "__orphan__";
export function groupColor(graph: Graph, rootId: string) {
  const i = graph.groups.findIndex((g) => g.root_concept_id === rootId);
  return i < 0 ? GROUP_COLORS[6] : GROUP_COLORS[i % GROUP_COLORS.length];
}

const NW = 104,
  NH = 30,
  GX = 12,
  GY = 26,
  PAD = 16,
  L1H = 34,
  LABEL = 26,
  MAXW = 1160;

export function layoutDomain(graph: Graph): { groups: Laid[]; height: number } {
  const leafs = graph.nodes
    .filter((n) => n.level !== 1)
    .map((n) => ({ ...n, x: 0, y: 0 }) as LaidNode);
  const l1s = new Map(
    graph.nodes.filter((n) => n.level === 1).map((n) => [n.concept_id, n]),
  );
  const known = new Set([
    ...graph.groups.map((g) => g.root_concept_id),
    ...l1s.keys(),
  ]);
  const order = [
    ...graph.groups.map((g) => g.root_concept_id),
    ...[...l1s.keys()].filter(
      (id) => !graph.groups.some((g) => g.root_concept_id === id),
    ),
    ORPHAN,
  ];
  const groups: Laid[] = [];
  for (const rootId of order) {
    const nodes = leafs.filter((n) =>
      rootId === ORPHAN ? !n.root || !known.has(n.root) : n.root === rootId,
    );
    if (!nodes.length) continue;
    // 부모(L2) 바로 뒤에 자식(L3)이 오도록 정렬 — 계층 엣지가 이웃 칸으로 떨어진다.
    const l2 = nodes
      .filter((n) => n.parent && l1s.has(n.parent))
      .sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
    const ordered: LaidNode[] = [];
    for (const p of l2) {
      ordered.push(p);
      ordered.push(...nodes.filter((n) => n.parent === p.concept_id));
    }
    for (const n of nodes) if (!ordered.includes(n)) ordered.push(n);
    const found = graph.groups.find((g) => g.root_concept_id === rootId);
    const group = found || {
      root_concept_id: rootId,
      name:
        rootId === ORPHAN ? "상위 개념 없음" : l1s.get(rootId)?.name || rootId,
      member_document_count: 0,
    };
    groups.push({
      group,
      l1: l1s.get(rootId),
      nodes: ordered,
      x: 0,
      y: 0,
      w: 0,
      h: 0,
      l1x: 0,
      l1y: 0,
    });
  }
  let x = 14,
    y = 96,
    rowH = 0;
  for (const g of groups) {
    const cols = Math.min(4, Math.max(2, Math.ceil(g.nodes.length / 3)));
    const rows = Math.ceil(g.nodes.length / cols);
    g.w = cols * (NW + GX) - GX + PAD * 2;
    g.h = PAD + L1H + 18 + rows * (NH + GY) - GY + LABEL + PAD;
    if (x + g.w > MAXW) {
      x = 14;
      y += rowH + 26;
      rowH = 0;
    }
    g.x = x;
    g.y = y;
    x += g.w + 20;
    rowH = Math.max(rowH, g.h);
    g.l1x = g.x + g.w / 2;
    g.l1y = g.y + PAD;
    g.nodes.forEach((n, i) => {
      n.x = g.x + PAD + (i % cols) * (NW + GX);
      n.y = g.y + PAD + L1H + 18 + Math.floor(i / cols) * (NH + GY);
    });
  }
  return { groups, height: y + rowH + 20 };
}

function pressable(action: () => void) {
  return {
    role: "button",
    tabIndex: 0,
    onClick: action,
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        action();
      }
    },
  } as const;
}

export default function DomainGraph({
  graph,
  selectedRoot,
  selectedConcept,
  zoom,
  onSelectNode,
  onSelectRoot,
}: {
  graph: Graph;
  selectedRoot: string;
  selectedConcept: string;
  zoom: number;
  onSelectNode: (id: string) => void;
  onSelectRoot: (id: string) => void;
}) {
  const { groups, height } = layoutDomain(graph);
  const rootX = 590,
    rootY = 16,
    ROOTW = 150,
    ROOTH = 40;
  const nodeAt = new Map<string, LaidNode>();
  for (const g of groups) for (const n of g.nodes) nodeAt.set(n.concept_id, n);
  const selectRoot = (id: string) => {
    if (id !== ORPHAN) onSelectRoot(id);
  };
  return (
    <svg
      className="v2-graph"
      viewBox={`0 0 1180 ${height}`}
      style={{ width: `${zoom * 100}%`, height: Math.min(660, height) * zoom }}
      aria-label="전체 개념 트리와 문서군 커버리지"
    >
      {groups.map((g) => {
        const id = g.group.root_concept_id;
        const color = groupColor(graph, id);
        const dim = selectedRoot && selectedRoot !== id ? " dim" : "";
        return (
          <g
            key={`hull-${id}`}
            {...pressable(() => selectRoot(id))}
            aria-label={`문서군 ${g.group.name}`}
            aria-pressed={selectedRoot === id}
          >
            <rect
              className={`hull${dim}`}
              x={g.x}
              y={g.y}
              width={g.w}
              height={g.h}
              rx={22}
              style={{ fill: `${color}10`, stroke: color }}
            />
            <text
              className={`hlabel${dim}`}
              x={g.x + 14}
              y={g.y + g.h - 12}
              style={{ fill: color }}
            >
              {g.group.name} · 문서 {g.group.member_document_count}
            </text>
          </g>
        );
      })}
      {groups.map((g) => (
        <g key={`edges-${g.group.root_concept_id}`}>
          <path
            className="gedge"
            d={`M${rootX + ROOTW / 2} ${rootY + ROOTH} C ${rootX + ROOTW / 2} ${rootY + ROOTH + 26}, ${g.l1x} ${g.l1y - 26}, ${g.l1x} ${g.l1y}`}
          />
          {g.nodes.map((n) => {
            const p = n.parent ? nodeAt.get(n.parent) : undefined;
            const fromX = p ? p.x + NW / 2 : g.l1x;
            const fromY = p ? p.y + NH : g.l1y + L1H;
            return (
              <line
                key={n.concept_id}
                className="gedge"
                x1={fromX}
                y1={fromY}
                x2={n.x + NW / 2}
                y2={n.y}
              />
            );
          })}
        </g>
      ))}
      <g aria-hidden="true">
        <rect
          className="gnode"
          x={rootX}
          y={rootY}
          width={ROOTW}
          height={ROOTH}
          rx={13}
          style={{ stroke: "#8d99ad", strokeWidth: 2 }}
        />
        <text className="ntext" x={rootX + ROOTW / 2} y={rootY + ROOTH / 2 - 5}>
          {graph.domain || "Domain"}
        </text>
        <text className="ncnt" x={rootX + ROOTW / 2} y={rootY + ROOTH / 2 + 11}>
          고정 개념 체계
        </text>
      </g>
      {groups.map((g) => {
        const id = g.group.root_concept_id;
        const color = groupColor(graph, id);
        const dim = selectedRoot && selectedRoot !== id ? " dim" : "";
        const l1sel = selectedRoot === id ? " sel" : "";
        return (
          <g key={`boxes-${id}`}>
            {/* L1 상자는 hull과 같은 동작을 하는 장식이라 접근성 이름을 중복시키지 않는다. */}
            <g aria-hidden="true" onClick={() => selectRoot(id)}>
              <rect
                className={`gnode${l1sel}${dim}`}
                x={g.l1x - 62}
                y={g.l1y}
                width={124}
                height={L1H}
                rx={11}
                style={{ stroke: color, fill: "#fff" }}
              />
              <text
                className="ntext"
                x={g.l1x}
                y={g.l1y + L1H / 2 + 1}
                style={{ fill: color }}
              >
                {g.l1 ? g.l1.name : g.group.name}
              </text>
            </g>
            {g.nodes.map((n) => {
              const sel = selectedConcept === n.concept_id ? " sel" : "";
              return (
                <g
                  key={n.concept_id}
                  {...pressable(() => onSelectNode(n.concept_id))}
                  aria-label={`개념 ${n.name}`}
                  aria-pressed={selectedConcept === n.concept_id}
                >
                  <rect
                    className={`gnode${sel}${dim}`}
                    x={n.x}
                    y={n.y}
                    width={NW}
                    height={NH}
                    rx={9}
                  />
                  <text className="ntext" x={n.x + NW / 2} y={n.y + 12}>
                    {n.name}
                  </text>
                  <text className="ncnt" x={n.x + NW / 2} y={n.y + 24}>
                    {n.sources ? `${n.sources} 출처` : "미연결"}
                  </text>
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
