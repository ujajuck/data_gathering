// 파싱 스키마 > 구조 보기 > 트리 보기(§7 SchemaTree). GET /schemas/{key}/tree의 중첩 응답 1회로 전체를 그린다.
// 펼침/접힘은 클라이언트 상태(기본 모두 펼침), 방향키·Home/End·Enter로 이동·선택, 선택 노드 강조, 폐기 필드는 흐리게.
import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { SchemaTreeNode } from "./types";

export const isDeprecated = (status: string | null | undefined) => status === "deprecated";

// 트리를 깊이 우선으로 펼친 목록(키보드 이동·이름 조회용).
export function flattenTree(nodes: SchemaTreeNode[], parent: string | null = null, depth = 0): { node: SchemaTreeNode; parent: string | null; depth: number }[] {
  const out: { node: SchemaTreeNode; parent: string | null; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, parent, depth });
    if (node.children?.length) out.push(...flattenTree(node.children, node.field_key, depth + 1));
  }
  return out;
}

export default function SchemaTree({
  rootName,
  nodes,
  selected,
  onSelect,
}: {
  rootName: string;
  nodes: SchemaTreeNode[];
  selected: string;
  onSelect: (fieldKey: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focused, setFocused] = useState<string>("");
  const tree = useRef<HTMLUListElement>(null);
  const flat = useMemo(() => flattenTree(nodes), [nodes]);
  // 보이는(조상이 접히지 않은) 노드만 키보드 이동 대상.
  const visible = useMemo(() => {
    const hidden = new Set<string>();
    const out: typeof flat = [];
    for (const item of flat) {
      if (item.parent && (hidden.has(item.parent) || collapsed.has(item.parent))) {
        hidden.add(item.node.field_key);
        continue;
      }
      out.push(item);
    }
    return out;
  }, [flat, collapsed]);
  const active = focused || selected || visible[0]?.node.field_key || "";

  function toggle(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  function focusKey(key: string) {
    setFocused(key);
    const el = Array.from(tree.current?.querySelectorAll<HTMLElement>("[data-field-key]") || []).find((node) => node.dataset.fieldKey === key);
    el?.focus();
  }
  function onKeyDown(e: ReactKeyboardEvent<HTMLUListElement>) {
    const index = visible.findIndex((v) => v.node.field_key === active);
    if (index < 0) return;
    const item = visible[index];
    const hasChildren = item.node.children?.length > 0;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (index + 1 < visible.length) focusKey(visible[index + 1].node.field_key);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (index > 0) focusKey(visible[index - 1].node.field_key);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (hasChildren && collapsed.has(item.node.field_key)) toggle(item.node.field_key);
        else if (hasChildren) focusKey(item.node.children[0].field_key);
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (hasChildren && !collapsed.has(item.node.field_key)) toggle(item.node.field_key);
        else if (item.parent) focusKey(item.parent);
        break;
      case "Home":
        e.preventDefault();
        if (visible.length) focusKey(visible[0].node.field_key);
        break;
      case "End":
        e.preventDefault();
        if (visible.length) focusKey(visible[visible.length - 1].node.field_key);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(item.node.field_key);
        break;
      default:
        return;
    }
  }

  function renderNode(node: SchemaTreeNode, depth: number) {
    const hasChildren = node.children?.length > 0;
    const open = !collapsed.has(node.field_key);
    const isSelected = node.field_key === selected;
    return (
      <li
        key={node.field_key}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isSelected}
        aria-expanded={hasChildren ? open : undefined}
        tabIndex={node.field_key === active ? 0 : -1}
        data-field-key={node.field_key}
        className={"v3-tree-item" + (isSelected ? " selected" : "") + (isDeprecated(node.status) ? " deprecated" : "")}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocused(node.field_key);
        }}
        onClick={(e) => {
          e.stopPropagation();
          setFocused(node.field_key);
          onSelect(node.field_key);
        }}
      >
        <div className="v3-tree-row" style={{ paddingLeft: 8 + depth * 18 }}>
          {hasChildren ? (
            <button
              type="button"
              className="v3-tree-toggle"
              tabIndex={-1}
              aria-label={(open ? "접기" : "펼치기") + " " + node.name}
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.field_key);
              }}
            >
              {open ? "▼" : "▶"}
            </button>
          ) : (
            <span className="v3-tree-toggle placeholder" aria-hidden="true" />
          )}
          <span className="v3-tree-name">{node.name}</span>
          {(node.type || node.unit) && (
            <small className="v3-muted">
              {node.type}
              {node.unit ? ` · ${node.unit}` : ""}
            </small>
          )}
          {isDeprecated(node.status) && <span className="v3-chip muted">폐기</span>}
        </div>
        {hasChildren && open && (
          <ul role="group" className="v3-tree-group">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <div className="v3-tree">
      <div className="v3-tree-root">
        <strong>{rootName}</strong>
        <span className="v3-muted v3-small">필드 {flat.length}</span>
      </div>
      <ul role="tree" aria-label="필드 트리" className="v3-tree-group" ref={tree} onKeyDown={onKeyDown}>
        {nodes.map((node) => renderNode(node, 0))}
      </ul>
    </div>
  );
}
