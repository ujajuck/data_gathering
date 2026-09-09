import { useEffect, useRef, useState } from "react";
import { Pager, State, usePage } from "./client";
import type { Row } from "./client";

export type TreeSelection = { roots: string[]; excluded: string[] };
export function selectionQuery(selection: TreeSelection) {
  const query = new URLSearchParams();
  selection.roots.forEach((id) => query.append("roots", id));
  selection.excluded.forEach((id) => query.append("excluded", id));
  return query.toString();
}
export default function ConceptTree({
  kg,
  selection,
  onChange,
  onFocus,
  parent = "",
  depth = 0,
}: {
  kg: string;
  selection: TreeSelection;
  onChange: (next: TreeSelection) => void;
  onFocus: (id: string) => void;
  parent?: string;
  depth?: number;
}) {
  const page = usePage(
    kg
      ? `/kg/${kg}/tree?parent_id=${encodeURIComponent(parent)}&${selectionQuery(selection)}`
      : null,
    `tree:${kg}:${parent}`,
  );
  // 선택 상태 재조회는 트리의 목록·페이지·펼친 노드를 바꾸지 않는다.
  const previous = useRef<{ key: string; items: Row[] }>({
    key: "",
    items: [],
  });
  const key = `${kg}:${parent}:${page.number}`;
  if (page.data) previous.current = { key, items: page.data.items };
  const nodes =
    page.data?.items ||
    (page.loading && previous.current.key === key
      ? previous.current.items
      : []);
  return (
    <div
      className="v2-concept-tree"
      role={depth ? "group" : "tree"}
      aria-label={depth ? undefined : "통합할 개념 트리"}
      aria-busy={page.loading}
    >
      <State resource={page} />
      {nodes.map((node) => (
        <TreeNode
          key={node.concept_id}
          {...{ kg, selection, onChange, onFocus, depth, node }}
        />
      ))}
      <Pager page={page} />
    </div>
  );
}
function TreeNode({
  node,
  kg,
  selection,
  onChange,
  onFocus,
  depth,
}: {
  node: Row;
  kg: string;
  selection: TreeSelection;
  onChange: (s: TreeSelection) => void;
  onFocus: (id: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(false);
  const [checked, setChecked] = useState(!!node.checked);
  useEffect(() => setChecked(!!node.checked), [node]);
  const check = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (check.current) check.current.indeterminate = !!node.indeterminate;
  }, [node.indeterminate]);
  return (
    <div
      role="treeitem"
      aria-expanded={node.child_count ? open : undefined}
      aria-checked={node.indeterminate ? "mixed" : !!node.checked}
    >
      <div className="v2-inline">
        <button
          aria-label={`${node.name} 하위 개념 ${open ? "접기" : "펼치기"}`}
          disabled={!node.child_count}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "−" : "+"}
        </button>
        <label className="v2-check">
          <input
            ref={check}
            type="checkbox"
            checked={checked}
            onChange={(e) => {
              setChecked(e.target.checked);
              const below = new Set([
                node.concept_id,
                ...(node.descendant_selections || []),
              ]);
              const roots = selection.roots.filter((id) => !below.has(id));
              const excluded = selection.excluded.filter(
                (id) => !below.has(id),
              );
              // 선택은 서버가 전체 하위 개념으로 확장한다. 화면에서 자식을 전부 읽지 않는다.
              onChange(
                e.target.checked
                  ? { roots: [...roots, node.concept_id], excluded }
                  : { roots, excluded: [...excluded, node.concept_id] },
              );
            }}
          />
          {node.name}
        </label>
        <button className="v2-link" onClick={() => onFocus(node.concept_id)}>
          출처 보기
        </button>
      </div>
      {open && (
        <ConceptTree
          {...{ kg, selection, onChange, onFocus }}
          parent={node.concept_id}
          depth={depth + 1}
        />
      )}
    </div>
  );
}
