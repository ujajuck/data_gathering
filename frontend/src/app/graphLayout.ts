// 스키마 그래프의 순수 배치·색 함수(§7 SchemaGraph 전용). 좌표 알고리즘은 그대로 두고 그리기는 SchemaGraph.tsx가 한다.
// 루트 → level 1 묶음 → 하위 노드 트리를 묶음별 hull 위에 배치한다.

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
    // 하위가 없는 level 1도 hull로 보여준다 (level 1만 있는 스키마가 빈 캔버스가 되지 않게).
    if (!nodes.length && rootId === ORPHAN) continue;
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
    // 36개까지는 최대 4열, 그보다 크면 정사각형에 가깝게(최대 8열) 배치해 세로로만 길어지지 않게 한다.
    const n = g.nodes.length;
    const cols = Math.max(
      2,
      n <= 36 ? Math.min(4, Math.ceil(n / 3)) : Math.min(8, Math.ceil(Math.sqrt(n))),
    );
    const rows = Math.ceil(g.nodes.length / cols);
    g.w = cols * (NW + GX) - GX + PAD * 2;
    g.h = PAD + L1H + (rows ? 18 + rows * (NH + GY) - GY : 0) + LABEL + PAD;
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
