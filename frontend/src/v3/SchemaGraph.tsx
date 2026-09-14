// 파싱 스키마 > 구조 보기 > 그래프 보기(§7 SchemaGraph). GET /schemas/{key}/graph 응답을 v2 DomainGraph의 순수 배치 함수
// layoutDomain 입력(Graph)으로 어댑트하고, SVG는 v3에서 새로 그린다(v2 컴포넌트는 import하지 않는다).
// 스키마 루트 → 그룹(level 1) → 필드. parent_of 관계는 실선, related_to는 점선. 노드는 버튼(이름 + 문서·프로파일 수).
import { useMemo, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { GROUP_COLORS, groupColor, layoutDomain } from "../v2/DomainGraph";
import type { Graph, GraphGroup, GraphNode } from "../v2/DomainGraph";
import type { SchemaGraph as SchemaGraphData, SchemaGraphEdge, SchemaGraphNode } from "./types";

export const ZOOM_LEVELS = [50, 75, 100, 125, 150];
const NODE_W = 104;
const NODE_H = 30;
const GROUP_W = 120;
const GROUP_H = 30;
const ROOT_W = 170;
const ROOT_H = 34;
const CANVAS_W = 1200;

export type GraphRelation = "parent_of" | "related_to";

export function relationOf(relation: string): GraphRelation {
  return /related/i.test(relation) ? "related_to" : "parent_of";
}

// level-1 조상(그룹)을 찾는다. 없으면 null(고아 → '상위 개념 없음' 묶음).
function rootOf(node: SchemaGraphNode, byKey: Map<string, SchemaGraphNode>): string | null {
  let current: SchemaGraphNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.field_key)) {
    seen.add(current.field_key);
    if (current.level === 1) return current.field_key;
    const parentKey: string | undefined = current.parents?.[0];
    current = parentKey ? byKey.get(parentKey) : undefined;
  }
  return null;
}

// §7: concept_id ← field_key, sources ← document_count, groups = level-1 필드.
export function adaptGraph(data: SchemaGraphData, schemaName: string): Graph {
  const byKey = new Map(data.nodes.map((n) => [n.field_key, n]));
  const nodes: GraphNode[] = data.nodes.map((n) => ({
    concept_id: n.field_key,
    name: n.name,
    level: n.level,
    parent: n.parents?.[0] ?? null,
    root: n.level === 1 ? n.field_key : rootOf(n, byKey),
    sources: n.document_count ?? 0,
  }));
  const groups: GraphGroup[] = data.nodes
    .filter((n) => n.level === 1)
    .map((n) => ({ root_concept_id: n.field_key, name: n.name, member_document_count: n.document_count ?? 0 }));
  return { domain: schemaName, nodes, groups, edges: [], truncated: false };
}

// 응답 edges + parents[]에서 유도한 parent_of(중복 제거).
export function graphEdges(data: SchemaGraphData): (SchemaGraphEdge & { kind: GraphRelation })[] {
  const out: (SchemaGraphEdge & { kind: GraphRelation })[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, relation: string) => {
    const kind = relationOf(relation);
    const id = kind === "related_to" ? [from, to].sort().join("~") + "~" + kind : `${from}>${to}>${kind}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ from, to, relation, kind });
  };
  for (const edge of data.edges || []) add(edge.from, edge.to, edge.relation);
  for (const node of data.nodes) for (const parent of node.parents || []) add(parent, node.field_key, "parent_of");
  return out;
}

type Box = { x: number; y: number; w: number; h: number };
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export default function SchemaGraph({
  data,
  schemaName,
  selected,
  onSelect,
}: {
  data: SchemaGraphData;
  schemaName: string;
  selected: string;
  onSelect: (fieldKey: string) => void;
}) {
  const [zoom, setZoom] = useState(100);
  const graph = useMemo(() => adaptGraph(data, schemaName), [data, schemaName]);
  const laid = useMemo(() => layoutDomain(graph), [graph]);
  const counts = useMemo(() => new Map(data.nodes.map((n) => [n.field_key, n])), [data]);
  const edges = useMemo(() => graphEdges(data), [data]);

  // 노드 상자 위치: 그룹(level 1)은 hull 상단 가운데, 필드는 layoutDomain 좌표.
  const boxes = useMemo(() => {
    const map = new Map<string, Box & { color: string }>();
    for (const g of laid.groups) {
      const color = groupColor(graph, g.group.root_concept_id);
      if (g.l1) map.set(g.l1.concept_id, { x: g.l1x - GROUP_W / 2, y: g.l1y, w: GROUP_W, h: GROUP_H, color });
      for (const n of g.nodes) map.set(n.concept_id, { x: n.x, y: n.y, w: NODE_W, h: NODE_H, color });
    }
    return map;
  }, [laid, graph]);
  const root: Box = { x: 14, y: 20, w: ROOT_W, h: ROOT_H };
  const height = Math.max(laid.height, 120);

  function key(fieldKey: string) {
    return (e: ReactKeyboardEvent<SVGGElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onSelect(fieldKey);
      }
    };
  }

  const nodeCount = boxes.size;
  const drawn = edges.filter((e) => boxes.has(e.from) && boxes.has(e.to));
  return (
    <div className="v3-graph">
      <div className="v3-toolbar">
        <label>
          확대
          <select aria-label="그래프 확대" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {ZOOM_LEVELS.map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </select>
        </label>
        <span className="v3-legend v3-small" aria-label="범례">
          <span className="v3-graph-legend solid">부모 → 자식</span>
          <span className="v3-graph-legend dashed">관련</span>
          <span className="v3-muted">노드 {nodeCount} · 관계 {drawn.length}</span>
        </span>
      </div>
      <div className="v3-graph-scroll">
        <svg
          className="v3-graph-svg"
          role="img"
          aria-label="스키마 그래프"
          data-nodes={nodeCount}
          data-edges={drawn.length}
          data-zoom={zoom}
          width={(CANVAS_W * zoom) / 100}
          height={(height * zoom) / 100}
          viewBox={`0 0 ${CANVAS_W} ${height}`}
        >
          {laid.groups.map((g) => {
            const color = groupColor(graph, g.group.root_concept_id);
            return (
              <g key={g.group.root_concept_id} className="v3-graph-hull" data-group={g.group.root_concept_id}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={10} fill={color} fillOpacity={0.06} stroke={color} strokeOpacity={0.35} />
                <text x={g.x + 12} y={g.y + g.h - 10} className="v3-graph-hull-label" fill={color}>
                  {g.group.name} · 문서 {g.group.member_document_count}
                </text>
              </g>
            );
          })}
          {/* 루트 → 그룹 */}
          {laid.groups
            .filter((g) => g.l1)
            .map((g) => {
              const to = boxes.get(g.l1!.concept_id)!;
              const a = center(root);
              const b = center(to);
              return <line key={"root-" + g.group.root_concept_id} className="v3-graph-edge parent_of" data-relation="parent_of" x1={a.x} y1={root.y + root.h} x2={b.x} y2={to.y} stroke={GROUP_COLORS[6]} />;
            })}
          {drawn.map((e, i) => {
            const a = center(boxes.get(e.from)!);
            const b = center(boxes.get(e.to)!);
            return (
              <line
                key={i}
                className={"v3-graph-edge " + e.kind}
                data-relation={e.kind}
                data-from={e.from}
                data-to={e.to}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={e.kind === "related_to" ? "#94a3b8" : boxes.get(e.to)!.color}
                strokeDasharray={e.kind === "related_to" ? "5 4" : undefined}
              />
            );
          })}
          <g className="v3-graph-node root" data-level="0">
            <rect x={root.x} y={root.y} width={root.w} height={root.h} rx={7} fill="#e8f0ff" stroke="#2563eb" />
            <text x={root.x + root.w / 2} y={root.y + 21} textAnchor="middle" className="v3-graph-title">
              {schemaName}
            </text>
          </g>
          {Array.from(boxes.entries()).map(([fieldKey, box]) => {
            const node = counts.get(fieldKey);
            const isSelected = fieldKey === selected;
            const isGroup = node?.level === 1;
            return (
              <g
                key={fieldKey}
                role="button"
                tabIndex={0}
                aria-label={node?.name || fieldKey}
                aria-pressed={isSelected}
                data-field-key={fieldKey}
                data-level={node?.level}
                className={"v3-graph-node" + (isSelected ? " selected" : "") + (isGroup ? " group" : "")}
                onClick={() => onSelect(fieldKey)}
                onKeyDown={key(fieldKey)}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={6}
                  fill={isSelected ? "#e8f0ff" : "#fff"}
                  stroke={isSelected ? "#2563eb" : box.color}
                  strokeWidth={isSelected ? 2 : 1.2}
                />
                <text x={box.x + box.w / 2} y={box.y + (isGroup ? 19 : 13)} textAnchor="middle" className={isGroup ? "v3-graph-title" : "v3-graph-name"}>
                  {node?.name || fieldKey}
                </text>
                {!isGroup && (
                  <text x={box.x + box.w / 2} y={box.y + 25} textAnchor="middle" className="v3-graph-counts">
                    문서 {node?.document_count ?? 0} · 프로파일 {node?.profile_count ?? 0}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
