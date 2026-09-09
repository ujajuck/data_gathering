import { useId, useRef, useState } from "react";
import { Pager, State, useNavigation, usePage } from "./client";
import type { Route, Row } from "./client";

export function coverageVersion(route: Route) {
  return route.coverage === "none" ? "" : route.coverage || route.version || "";
}

type GraphConcept = {
  concept_id: string;
  name: string;
  level: number;
  status: string;
  canonical_unit: string | null;
  coverage: {
    proposed: number;
    approved: number;
    rejected: number;
    published_series: number;
  } | null;
};

function status(node: GraphConcept) {
  const c = node.coverage;
  if (!c) return "문서 미선택";
  if (!c.proposed && !c.approved && !c.rejected) return "미연결";
  return `승인 ${c.approved} · 검수 ${c.proposed} · 반려 ${c.rejected}`;
}

// 고정 레벨/ID 순서로 배치한다. 커버리지 재조회가 노드 위치를 흔들지 않는다.
function layout(nodes: GraphConcept[]) {
  const sorted = [...nodes].sort(
    (a, b) => a.level - b.level || a.concept_id.localeCompare(b.concept_id),
  );
  const levels = [...new Set(sorted.map((n) => n.level))];
  const rows = [0, 0, 0, 0, 0];
  const positions = sorted.map((n) => {
    const column = Math.min(4, levels.indexOf(n.level));
    return { ...n, x: 30 + column * 268, y: 42 + rows[column]++ * 110 };
  });
  return {
    nodes: positions,
    width: Math.max(560, Math.min(5, levels.length) * 268 + 30),
    height: Math.max(420, Math.max(...rows) * 110 + 62),
  };
}

export default function KnowledgeGraph({
  kg,
  query,
}: {
  kg: string;
  query: string;
}) {
  const { route, go, refresh } = useNavigation();
  const version = coverageVersion(route);
  const focus = route.graph_focus || "";
  const graphPath = kg
    ? `/kg/${kg}/graph?` +
      new URLSearchParams({
        q: query,
        focus_id: focus,
        ...(version ? { document_version_id: version } : {}),
      })
    : null;
  // 검수 갱신은 커버리지만 바꾼다. 같은 KG/문서/검색 범위의 페이지를 유지한다.
  const graph = usePage(
    graphPath ? graphPath + "&r=" + refresh : null,
    graphPath,
  );
  const data = graph.data as Row | null;
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");
  const documents = usePage(
    picker ? "/documents?q=" + encodeURIComponent(search) : null,
  );
  const [zoom, setZoom] = useState(1);
  const view = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const marker = useId().replace(/:/g, "");
  const drawn = layout([
    ...(data?.items || []),
    ...(data?.focus ? [data.focus] : []),
  ]);
  const at = new Map(drawn.nodes.map((n) => [n.concept_id, n]));
  function resetView() {
    setZoom(1);
    if (view.current) {
      view.current.scrollLeft = 0;
      view.current.scrollTop = 0;
    }
  }
  return (
    <section className="v2-kg-graph" aria-label="KG 커버리지 그래프">
      <div className="v2-inline">
        <button
          disabled={!route.concept}
          onClick={() => {
            go({ kg, graph_focus: route.concept });
            resetView();
          }}
        >
          선택 개념 주변
        </button>
        <button
          disabled={!focus}
          onClick={() => {
            go({ graph_focus: "" });
            resetView();
          }}
        >
          전체 개념 목록으로
        </button>
        <label>
          그래프 확대
          <select
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((n) => (
              <option key={n} value={n}>
                {n * 100}%
              </option>
            ))}
          </select>
        </label>
        <button onClick={resetView}>보기 초기화</button>
      </div>
      <details
        className="v2-details"
        onToggle={(e) => setPicker(e.currentTarget.open)}
      >
        <summary>커버리지 문서 선택</summary>
        <label>
          커버리지 문서 검색
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="문서명 검색"
          />
        </label>
        <State resource={documents} />
        <label>
          문서의 현재 버전 선택
          <select
            value=""
            onChange={(e) => e.target.value && go({ coverage: e.target.value })}
          >
            <option value="">문서 선택</option>
            {documents.data?.items.map((d) => (
              <option key={d.document_id} value={d.current_version_id}>
                {d.display_name}
              </option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="커버리지 문서 페이지">
          <Pager page={documents} />
        </div>
      </details>
      <div className="v2-inline">
        <p className="v2-muted" role="status">
          {data?.coverage_version
            ? `${data.coverage_version.filename} · v${data.coverage_version.revision_no} · ${data.coverage_version.is_current ? "현재 버전" : "과거 버전"}`
            : version
              ? "선택한 문서 버전의 권한·커버리지 확인"
              : "문서를 선택하면 검수·발행 상태를 표시합니다."}
        </p>
        {version && (
          <button onClick={() => go({ coverage: "none" })}>
            문서 선택 해제
          </button>
        )}
      </div>
      <p className="v2-muted">
        {focus ? "선택 개념과 한 단계 이웃" : "페이지에 포함된 개념과 관계"} ·
        최대 30개 + 중심 1개. 빈 공간을 드래그하거나 스크롤해 이동하세요. 노드는
        Enter/Space로 선택할 수 있습니다.
      </p>
      <State resource={{ ...graph, data: null }} />
      {data && (
        <>
          {!drawn.nodes.length ? (
            <p className="v2-empty">일치하는 개념이 없습니다.</p>
          ) : (
            <div
              className="v2-kg-canvas"
              ref={view}
              key={kg + focus + query + graph.number}
              onPointerDown={(e) => {
                if (
                  e.button !== 0 ||
                  (e.target as Element).closest('[role="button"]')
                )
                  return;
                const el = e.currentTarget;
                drag.current = {
                  x: e.clientX,
                  y: e.clientY,
                  left: el.scrollLeft,
                  top: el.scrollTop,
                };
                el.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                e.currentTarget.scrollLeft =
                  drag.current.left - e.clientX + drag.current.x;
                e.currentTarget.scrollTop =
                  drag.current.top - e.clientY + drag.current.y;
              }}
              onPointerUp={(e) => {
                drag.current = null;
                if (e.currentTarget.hasPointerCapture(e.pointerId))
                  e.currentTarget.releasePointerCapture(e.pointerId);
              }}
              onLostPointerCapture={() => {
                drag.current = null;
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              <svg
                width={drawn.width * zoom}
                height={drawn.height * zoom}
                viewBox={`0 0 ${drawn.width} ${drawn.height}`}
                role="group"
                aria-label="도메인 관계와 문서 커버리지"
              >
                <defs>
                  <marker
                    id={marker}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path
                      d="M 0 0 L 10 5 L 0 10 z"
                      fill="var(--product-muted)"
                    />
                  </marker>
                </defs>
                {(data.edges || []).map((edge: Row) => {
                  const a = at.get(edge.from_concept_id),
                    b = at.get(edge.to_concept_id);
                  if (!a || !b) return null;
                  const horizontal = a.x !== b.x;
                  const direction = horizontal
                    ? Math.sign(b.x - a.x)
                    : Math.sign(b.y - a.y);
                  const x1 =
                    a.x + (horizontal ? (direction > 0 ? 208 : 0) : 104);
                  const x2 =
                    b.x + (horizontal ? (direction > 0 ? 0 : 208) : 104);
                  const y1 = a.y + (horizontal ? 42 : direction > 0 ? 84 : 0);
                  const y2 = b.y + (horizontal ? 42 : direction > 0 ? 0 : 84);
                  const dx = horizontal ? direction * 40 : 0,
                    dy = horizontal ? 0 : direction * 26;
                  return (
                    <path
                      key={JSON.stringify([
                        edge.from_concept_id,
                        edge.to_concept_id,
                        edge.relation_type,
                      ])}
                      className={
                        "v2-kg-edge " +
                        (edge.relation_type === "parent_of"
                          ? "hierarchy"
                          : "related")
                      }
                      d={`M ${x1} ${y1} C ${x1 + dx} ${y1 + dy}, ${x2 - dx} ${y2 - dy}, ${x2} ${y2}`}
                      markerEnd={`url(#${marker})`}
                    >
                      <title>
                        {a.name} → {b.name} · {edge.relation_type}
                      </title>
                    </path>
                  );
                })}
                {drawn.nodes.map((n) => (
                  <g
                    key={n.concept_id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.name} · ${status(n)}${n.coverage ? ` · 발행 시리즈 ${n.coverage.published_series}` : ""}`}
                    aria-pressed={route.concept === n.concept_id}
                    className={
                      "v2-kg-node" +
                      (route.concept === n.concept_id ? " selected" : "") +
                      (n.coverage?.published_series ? " covered" : "")
                    }
                    transform={`translate(${n.x} ${n.y})`}
                    onClick={() => go({ kg, concept: n.concept_id })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        go({ kg, concept: n.concept_id });
                      }
                    }}
                  >
                    <title>
                      {n.name} · L{n.level} ·{" "}
                      {n.status === "deprecated" ? "폐기" : "활성"} ·{" "}
                      {status(n)}
                    </title>
                    <rect width="208" height="84" rx="9" />
                    <text x="12" y="21" className="v2-kg-name">
                      {n.name.length > 17 ? n.name.slice(0, 17) + "…" : n.name}
                    </text>
                    <text x="12" y="40">
                      L{n.level}
                      {n.status === "deprecated" ? " · 폐기" : ""} ·{" "}
                      {n.canonical_unit || "단위 없음"}
                    </text>
                    <text x="12" y="57">
                      {status(n)}
                    </text>
                    <text x="12" y="73">
                      {n.coverage
                        ? `발행 시리즈 ${n.coverage.published_series}`
                        : "고정 도메인 개념"}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          )}
          <p className="v2-muted">
            실선: 상하위 · 점선: 기타 관계 · 파란 테두리: 선택 · 초록 테두리:
            발행 시리즈 있음.
          </p>
          {data.edges_truncated && (
            <p role="status">
              관계가 많아 120개만 표시했습니다. 개념을 선택하면 연결 관계
              목록에서 나머지도 확인할 수 있습니다.
            </p>
          )}
          <p className="v2-muted">
            승인·검수·반려는 최신 규칙 수, 발행은 현재 유효한 시리즈 수입니다.
            원본 값 개수나 문서 전체 커버리지 비율을 뜻하지 않습니다.
          </p>
        </>
      )}
      <div role="group" aria-label="그래프 페이지">
        <Pager page={graph} />
      </div>
    </section>
  );
}
