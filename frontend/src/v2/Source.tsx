import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  api,
  box,
  column,
  useDraft,
  Pager,
  range,
  State,
  useData,
  useNavigation,
  usePage,
  useTasks,
  useViewport,
} from "./client";
import type { Row } from "./client";
import { AssignTemplate, Heading } from "./Workbench";
import { RevisionHistory } from "./Review";
import Presets from "./Presets";

export default function Source() {
  const { route, go, refresh, changed } = useNavigation();
  const tasks = useTasks();
  const sheets = usePage(
    route.version ? "/versions/" + route.version + "/sheets" : null,
  );
  const applications = usePage(
    route.version
      ? "/applications?version_id=" + route.version + "&r=" + refresh
      : null,
  );
  const application = useData(
    route.application
      ? "/applications/" + route.application + "?r=" + refresh
      : null,
  );
  const mappings = usePage(
    route.application
      ? "/applications/" + route.application + "/mappings?r=" + refresh
      : null,
  );
  const mapping = useData(route.mapping ? "/mappings/" + route.mapping : null);
  const [draftSpec, setDraftSpec] = useDraft<Row>(
    "mapping:" + route.mapping,
    mapping.data?.effective_spec || {},
  );
  const [viewRevision, setViewRevision] = useState(0);
  const r1 = Math.max(1, Math.min(1048576, Number(route.row) || 1));
  const c1 = Math.max(1, Math.min(16384, Number(route.col) || 1));
  const view = useViewport(
    route.version || "",
    route.sheet || "",
    r1,
    c1,
    viewRevision,
  );
  const [zoom, setZoom] = useDraft("source-zoom", 1);
  const [tool, setTool] = useState("value");
  const [selection, setSelection] = useState<Row | null>(null);
  const [jump, setJump] = useState("A1");
  const series = usePage(
    application.data?.published_run_id
      ? "/series?run_id=" + application.data.published_run_id
      : null,
  );
  const items = usePage(
    route.series ? "/series/" + route.series + "/items" : null,
  );
  const parts = usePage(
    route.item ? "/items/" + route.item + "/regions" : null,
  );
  useEffect(() => {
    if (!route.sheet && sheets.data?.items[0])
      go({ sheet: sheets.data.items[0].sheet_id, row: "1", col: "1" }, true);
  }, [route.sheet, sheets.data]);
  useEffect(() => {
    if (!route.mapping && mappings.data?.items[0])
      go({ mapping: mappings.data.items[0].mapping_revision_id }, true);
  }, [route.mapping, mappings.data]);
  useEffect(() => {
    if (route.item && parts.data?.items.length && (!route.row || !route.col)) {
      const p =
        parts.data.items.find(
          (p) => p.role === "value" || p.role === "input",
        ) || parts.data.items[0];
      go(
        {
          version: p.document_version_id,
          sheet: p.sheet_id,
          row: String(p.r1),
          col: String(p.c1),
        },
        true,
      );
    }
  }, [route.item, route.row, route.col, parts.data]);
  useEffect(() => {
    setSelection(null);
  }, [route.version, route.sheet, route.mapping]);
  const focus = (p: Row) =>
    go({
      version: p.document_version_id,
      sheet: p.sheet_id,
      row: String(p.r1),
      col: String(p.c1),
    });
  const displaySheet =
    application.data?.bindings.find((b: Row) => b.sheet_id === route.sheet)
      ?.name ||
    sheets.data?.items.find((s) => s.sheet_id === route.sheet)?.name ||
    "선택한 시트";
  return (
    <>
      <Heading
        eyebrow="03 / SOURCE REVIEW"
        title="값과 근거를 함께 검수하세요"
        description="영역을 선택해 키·값 위치를 수정하고 연결 개념을 승인합니다. 원본 파일은 변경하지 않으며 수정할 때마다 검수 버전이 남습니다."
      />
      {!route.version ? (
        <section className="v2-card v2-empty">
          <p>문서 탭에서 문서와 시트를 선택하세요.</p>
          <button className="primary" onClick={() => go({ tab: "documents" })}>
            문서 선택 →
          </button>
        </section>
      ) : (
        <>
          <div className="v2-context">
            <span>
              문서 버전 <code>{route.version.slice(0, 8)}</code>
            </span>
            <strong>{displaySheet}</strong>
            <button onClick={() => go({ tab: "documents" })}>
              문서 · 버전 선택
            </button>
            <span className="v2-spacer" />
            <button onClick={() => setViewRevision((n) => n + 1)}>
              표시 새로고침
            </button>
          </div>
          <div className="v2-source-layout">
            <aside className="v2-card v2-source-nav">
              <h2>시트</h2>
              <State resource={sheets} />
              {sheets.data?.items.map((s) => (
                <button
                  className={
                    "v2-list-item " +
                    (s.sheet_id === route.sheet ? "selected" : "")
                  }
                  key={s.sheet_id}
                  onClick={() =>
                    go({ sheet: s.sheet_id, row: "1", col: "1", item: "" })
                  }
                >
                  {s.name}
                  <small>
                    {s.visibility === "visible" ? "" : s.visibility}
                  </small>
                </button>
              ))}
              <Pager page={sheets} />
              <h2>연결 템플릿</h2>
              <State
                resource={applications}
                empty="이 문서 버전에 템플릿을 연결하세요."
              />
              {applications.data?.items.map((a) => (
                <button
                  className={
                    "v2-list-item " +
                    (a.application_id === route.application ? "selected" : "")
                  }
                  key={a.application_id}
                  onClick={() =>
                    go({
                      application: a.application_id,
                      mapping: "",
                      series: "",
                      item: "",
                    })
                  }
                >
                  <span>
                    <strong>
                      {a.name} · v{a.revision_no}
                    </strong>
                    <small>
                      {a.published_run_id ? "추출 발행됨" : "검수 · 추출 필요"}
                    </small>
                  </span>
                </button>
              ))}
              <Pager page={applications} />
              <AssignTemplate />
              {route.application && (
                <>
                  <h2>추출 규칙</h2>
                  <State resource={mappings} />
                  {mappings.data?.items.map((m) => (
                    <button
                      className={
                        "v2-list-item " +
                        (m.mapping_revision_id === route.mapping
                          ? "selected"
                          : "")
                      }
                      key={m.mapping_revision_id}
                      onClick={() =>
                        go({
                          mapping: m.mapping_revision_id,
                          series: "",
                          item: "",
                        })
                      }
                    >
                      <span>
                        <strong>{m.rule_key}</strong>
                        <small>
                          {m.status === "approved" ? "승인" : "검수 대기"} · r
                          {m.revision_no}
                        </small>
                      </span>
                    </button>
                  ))}
                  <Pager page={mappings} />
                  <button
                    className="primary full"
                    disabled={tasks.busy}
                    onClick={() =>
                      tasks.run(
                        "/applications/" + route.application + "/extract",
                        {},
                        () => {
                          changed();
                          go({ series: "", item: "" });
                        },
                      )
                    }
                  >
                    승인한 규칙으로 추출
                  </button>
                </>
              )}
            </aside>
            <section className="v2-card v2-canvas-card">
              <div className="v2-toolbar">
                <div className="v2-segment">
                  <button
                    className={tool === "key" ? "active key" : ""}
                    onClick={() => setTool("key")}
                  >
                    키 선택
                  </button>
                  <button
                    className={tool === "value" ? "active value" : ""}
                    onClick={() => setTool("value")}
                  >
                    값 선택
                  </button>
                  <button
                    className={tool === "unit" ? "active unit" : ""}
                    onClick={() => setTool("unit")}
                  >
                    단위 선택
                  </button>
                </div>
                <label className="v2-inline">
                  확대
                  <select
                    aria-label="확대 배율"
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                  >
                    {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => (
                      <option value={z} key={z}>
                        {z * 100}%
                      </option>
                    ))}
                  </select>
                </label>
                <form
                  className="v2-inline"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const b = box(jump);
                    if (b) go({ row: String(b[0]), col: String(b[1]) });
                  }}
                >
                  <input
                    aria-label="원본 주소 이동"
                    value={jump}
                    onChange={(e) => setJump(e.target.value)}
                    placeholder="A1"
                  />
                  <button>이동</button>
                </form>
              </div>
              <div className="v2-fidelity">
                {view.data?.mode === "native"
                  ? "원본 렌더 · 제공자가 반환한 셀 좌표"
                  : view.data?.fidelity || "현재 표시 범위만 불러옵니다."}
              </div>
              <State resource={view} />
              {selection && !mapping.data && (
                <p className="v2-note" role="status">
                  먼저 추출 규칙을 선택하세요.
                </p>
              )}
              <div className="v2-view-scroll">
                {view.data && (
                  <Grid
                    view={view.data}
                    zoom={zoom}
                    spec={draftSpec}
                    bindings={application.data?.bindings || []}
                    sheet={route.sheet}
                    selection={selection}
                    role={tool}
                    onSelect={(area) =>
                      setSelection({
                        ...area,
                        role: tool,
                        sheet_id: route.sheet,
                      })
                    }
                    focus={
                      parts.data?.items.filter(
                        (p) => p.sheet_id === route.sheet,
                      ) || []
                    }
                  />
                )}
              </div>
              <div className="v2-toolbar v2-bottom">
                <button
                  disabled={r1 <= 1}
                  onClick={() => go({ row: String(Math.max(1, r1 - 40)) })}
                >
                  ↑ 40행
                </button>
                <button
                  disabled={r1 + 40 > 1048576}
                  onClick={() => go({ row: String(r1 + 40) })}
                >
                  ↓ 40행
                </button>
                <button
                  disabled={c1 <= 1}
                  onClick={() => go({ col: String(Math.max(1, c1 - 12)) })}
                >
                  ← 12열
                </button>
                <button
                  disabled={c1 + 12 > 16384}
                  onClick={() => go({ col: String(c1 + 12) })}
                >
                  12열 →
                </button>
                <span>
                  {range(
                    r1,
                    c1,
                    Math.min(1048576, r1 + 39),
                    Math.min(16384, c1 + 11),
                  )}{" "}
                  · 최대 480셀
                </span>
              </div>
            </section>
            <aside className="v2-card v2-inspector">
              <h2>매핑 검수</h2>
              <State resource={mapping} />
              {mapping.data && application.data ? (
                <MappingEditor
                  key={mapping.data.mapping_revision_id}
                  mapping={mapping.data}
                  spec={draftSpec}
                  setSpec={setDraftSpec}
                  application={application.data}
                  selection={selection}
                  clearSelection={() => setSelection(null)}
                />
              ) : (
                <p className="v2-empty">템플릿의 추출 규칙을 선택하세요.</p>
              )}
            </aside>
          </div>
          <section className="v2-card v2-space">
            <div className="v2-card-head">
              <h2>추출값 · 원본 출처</h2>
              {!application.data?.published_run_id && (
                <span className="v2-badge">현재 발행 결과 없음</span>
              )}
            </div>
            <div className="v2-grid three">
              <div>
                <h3>값 목록 선택</h3>
                <State resource={series} empty="검수 후 추출을 실행하세요." />
                {series.data?.items.map((s) => (
                  <button
                    key={s.series_id}
                    className={
                      "v2-list-item " +
                      (route.series === s.series_id ? "selected" : "")
                    }
                    onClick={() =>
                      go({
                        series: s.series_id,
                        mapping: s.mapping_revision_id,
                        item: "",
                      })
                    }
                  >
                    <span>
                      <strong>{s.observed_key || s.rule_key}</strong>
                      <small>
                        {s.cardinality} · {s.axis}
                      </small>
                    </span>
                  </button>
                ))}
                <Pager page={series} />
              </div>
              <div>
                <h3>항목별 값</h3>
                <State resource={items} />
                <div className="v2-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>업무 행</th>
                        <th>값</th>
                        <th>단위</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.data?.items.map((i) => (
                        <tr key={i.item_id}>
                          <td>{i.record_key}</td>
                          <td>
                            <button
                              className="v2-link"
                              onClick={() =>
                                go({ item: i.item_id, row: "", col: "" })
                              }
                            >
                              {i.value_text ?? "빈칸"}
                              {i.preview_truncated ? "…" : ""}
                            </button>
                          </td>
                          <td>{i.unit_normalized}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pager page={items} />
              </div>
              <div>
                <h3>선택 항목의 모든 출처</h3>
                <State resource={parts} />
                {parts.data?.items.map((p) => (
                  <button
                    className="v2-list-item"
                    key={p.role + ":" + p.ordinal}
                    onClick={() => focus(p)}
                  >
                    <span>
                      <strong>
                        {p.name}!{range(p.r1, p.c1, p.r2, p.c2)}
                      </strong>
                      <small>
                        {p.role} · {p.document_version_id.slice(0, 8)}
                      </small>
                    </span>
                    <span>↗</span>
                  </button>
                ))}
                <Pager page={parts} />
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
function Grid({
  view,
  zoom,
  spec,
  bindings,
  sheet,
  selection,
  role,
  onSelect,
  focus,
}: {
  view: Row;
  zoom: number;
  spec?: Row;
  bindings: Row[];
  sheet: string;
  selection: Row | null;
  role: string;
  onSelect: (area: Row) => void;
  focus: Row[];
}) {
  const start = useRef<Row | null>(null);
  const [drag, setDrag] = useState<Row | null>(null);
  function rect(region: Row): CSSProperties | null {
    const rows = view.rows.filter(
        (r: Row) => r.index >= region.r1 && r.index <= region.r2,
      ),
      cols = view.columns.filter(
        (c: Row) => c.index >= region.c1 && c.index <= region.c2,
      );
    if (!rows.length || !cols.length) return null;
    return {
      left: cols[0].x,
      top: rows[0].y,
      width: cols.at(-1).x + cols.at(-1).width - cols[0].x,
      height: rows.at(-1).y + rows.at(-1).height - rows[0].y,
    };
  }
  const overlays: Row[] = [];
  for (const kind of ["key", "value", "unit"])
    for (const area of spec?.selector?.[kind]?.areas || []) {
      if (
        !bindings.some(
          (b) => b.role_key === area.sheet_role && b.sheet_id === sheet,
        )
      )
        continue;
      const b = area.range && box(area.range);
      if (b) overlays.push({ r1: b[0], c1: b[1], r2: b[2], c2: b[3], kind });
    }
  if (selection) overlays.push({ ...selection, kind: selection.role });
  if (drag) overlays.push({ ...drag, kind: role });
  focus.forEach((r) => overlays.push({ ...r, kind: "focus" }));
  function extent(end: Row) {
    const from = start.current!;
    return {
      r1: Math.min(from.r1, end.r1),
      c1: Math.min(from.c1, end.c1),
      r2: Math.max(from.r2, end.r2),
      c2: Math.max(from.c2, end.c2),
    };
  }
  function finish(end: Row) {
    if (start.current) {
      onSelect(extent(end));
      start.current = null;
      setDrag(null);
    }
  }
  return (
    <div
      style={{
        width: (view.width + 44) * zoom,
        height: (view.height + 28) * zoom,
      }}
      className="v2-grid-size"
    >
      <div
        className="v2-sheet"
        style={{
          width: view.width + 44,
          height: view.height + 28,
          transform: `scale(${zoom})`,
        }}
        onPointerLeave={() => {
          start.current = null;
          setDrag(null);
        }}
      >
        <div className="v2-corner" />
        {view.columns.map((c: Row) => (
          <div
            className="v2-col-heading"
            key={c.index}
            style={{ left: c.x + 44, width: c.width }}
          >
            {column(c.index)}
          </div>
        ))}
        {view.rows.map((r: Row) => (
          <div
            className="v2-row-heading"
            key={r.index}
            style={{ top: r.y + 28, height: r.height }}
          >
            {r.index}
          </div>
        ))}
        <div
          className="v2-sheet-body"
          style={{ left: 44, top: 28, width: view.width, height: view.height }}
        >
          {view.mode === "native" &&
            view.images.map((im: Row, i: number) => (
              <img
                draggable={false}
                alt="원본 문서 표시 범위"
                key={i}
                src={im.data_url}
                style={{
                  position: "absolute",
                  left: im.x,
                  top: im.y,
                  width: im.width,
                  height: im.height,
                  pointerEvents: "none",
                }}
              />
            ))}
          {view.cells.map((cell: Row) => (
            <button
              key={cell.range}
              aria-label={`${cell.range} ${cell.text || ""}`}
              className={"v2-cell " + (view.mode === "native" ? "native" : "")}
              style={{
                ...(view.mode === "native" ? {} : cell.style),
                left: cell.x,
                top: cell.y,
                width: cell.width,
                height: cell.height,
              }}
              title={cell.range + (cell.text ? " · " + cell.text : "")}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                start.current = cell;
                setDrag(cell);
              }}
              onPointerEnter={() => {
                if (start.current) setDrag(extent(cell));
              }}
              onPointerUp={() => finish(cell)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(cell);
                }
              }}
            >
              {view.mode === "native" ? "" : cell.text}
            </button>
          ))}
          {view.mode !== "native" &&
            view.images.map((im: Row, i: number) => (
              <img
                draggable={false}
                alt="시트 이미지"
                key={i}
                src={im.data_url}
                style={{
                  position: "absolute",
                  left: im.x,
                  top: im.y,
                  width: im.width,
                  height: im.height,
                  pointerEvents: "none",
                }}
              />
            ))}
          {overlays.map((overlay, i) => {
            const geometry = rect(overlay);
            return (
              geometry && (
                <div
                  key={i}
                  className={"v2-overlay " + overlay.kind}
                  style={geometry}
                />
              )
            );
          })}
        </div>
      </div>
    </div>
  );
}
function MappingEditor({
  mapping,
  spec,
  setSpec,
  application,
  selection,
  clearSelection,
}: {
  mapping: Row;
  spec: Row;
  setSpec: (next: Row | ((old: Row) => Row)) => void;
  application: Row;
  selection: Row | null;
  clearSelection: () => void;
}) {
  const { route, go, changed } = useNavigation();
  const [concept, setConcept] = useDraft(
    "concept:" + mapping.mapping_revision_id,
    mapping.concept_id || "",
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const concepts = usePage(
    "/kg/" +
      mapping.kg_revision_id +
      "/concepts?q=" +
      encodeURIComponent(search),
  );
  const [alias, setAlias] = useState("");
  const [term, setTerm] = useState("");
  const aliases = usePage(
    term
      ? "/kg/" +
          mapping.kg_revision_id +
          "/aliases?text=" +
          encodeURIComponent(term)
      : null,
  );
  const roles = application.bindings
    .filter((b: Row) => b.sheet_id === selection?.sheet_id)
    .map((b: Row) => b.role_key);
  const [selectedRole, setSelectedRole] = useState("");
  const [reason, setReason] = useDraft(
    "reason:" + mapping.mapping_revision_id,
    "원본 영역·개념 검수",
  );
  const [status, setStatus] = useDraft(
    "status:" + mapping.mapping_revision_id,
    mapping.status === "approved" ? "approved" : "proposed",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(JSON.stringify(spec, null, 2));
  function valueChange(changes: Row) {
    setSpec((s) => ({
      ...s,
      selector: { ...s.selector, value: { ...s.selector.value, ...changes } },
    }));
  }
  function add() {
    const role = roles.includes(selectedRole) ? selectedRole : roles[0];
    if (!selection || !role) return;
    const kind = selection.role;
    setSpec((s) => ({
      ...s,
      selector: {
        ...s.selector,
        [kind]: {
          ...s.selector[kind],
          areas: [
            ...(s.selector[kind]?.areas || []),
            {
              sheet_role: role,
              range: range(
                selection.r1,
                selection.c1,
                selection.r2,
                selection.c2,
              ),
            },
          ],
        },
      },
    }));
    clearSelection();
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await api(
        "/applications/" +
          mapping.application_id +
          "/mappings/" +
          mapping.mapping_revision_id +
          "/revisions",
        {
          expected_seq: mapping.edit_seq,
          effective_spec: spec,
          concept_id: concept || null,
          status,
          reason,
        },
      );
      changed();
      go({ mapping: result.mapping_revision_id, series: "", item: "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="v2-card-head">
        <strong>{mapping.rule_key}</strong>
        <span className="v2-badge">r{mapping.revision_no}</span>
      </div>
      <p className="v2-muted">선택한 템플릿 적용 건에만 저장됩니다.</p>
      {selection && (
        <div className="v2-selection">
          <strong>
            {selection.role} ·{" "}
            {range(selection.r1, selection.c1, selection.r2, selection.c2)}
          </strong>
          {roles.length > 1 && (
            <select
              aria-label="선택 영역의 시트 역할"
              value={selectedRole || roles[0]}
              onChange={(e) => setSelectedRole(e.target.value)}
            >
              {roles.map((r: string) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          )}
          {!roles.length ? (
            <p>현재 시트가 이 템플릿에 연결되어 있지 않습니다.</p>
          ) : (
            <button onClick={add}>이 영역 추가</button>
          )}
        </div>
      )}
      {["key", "value", "unit", "context"].map((kind) => (
        <div className={"v2-areas " + kind} key={kind}>
          <h3>
            {
              {
                key: "키 영역",
                value: "값 영역",
                unit: "단위 영역",
                context: "문맥 영역",
              }[kind]
            }
          </h3>
          {(spec.selector[kind]?.areas || []).map((a: Row, i: number) => (
            <div className="v2-area" key={i}>
              <button
                className="v2-link"
                onClick={() => {
                  const b = box(a.range || "");
                  const s = application.bindings.find(
                    (x: Row) => x.role_key === a.sheet_role,
                  );
                  if (b && s)
                    go({
                      sheet: s.sheet_id,
                      row: String(b[0]),
                      col: String(b[1]),
                    });
                }}
              >
                {a.sheet_role} ·{" "}
                {a.range || JSON.stringify(a.find || a.relative)}
              </button>
              <button
                aria-label={`${kind} 영역 ${i + 1} 삭제`}
                onClick={() =>
                  setSpec((s) => {
                    const next = structuredClone(s);
                    next.selector[kind].areas.splice(i, 1);
                    if (
                      !next.selector[kind].areas.length &&
                      ["unit", "context"].includes(kind)
                    )
                      delete next.selector[kind];
                    return next;
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ))}
      <label>
        값 모양 · 방향
        <select
          value={
            spec.selector.value.cardinality + ":" + spec.selector.value.axis
          }
          onChange={(e) => {
            const [cardinality, axis] = e.target.value.split(":");
            valueChange({
              cardinality,
              axis,
              element_layout:
                axis === "down"
                  ? "one_per_row"
                  : axis === "right"
                    ? "one_per_column"
                    : "each_cell",
            });
          }}
        >
          <option value="scalar:none">단일 값</option>
          <option value="list:down">목록 · 아래로</option>
          <option value="list:right">목록 · 오른쪽으로</option>
          <option value="matrix:row_major">행렬 · 행 우선</option>
          <option value="matrix:column_major">행렬 · 열 우선</option>
        </select>
      </label>
      <label>
        종료 조건
        <select
          value={spec.selector.value.stop?.kind || "explicit_areas"}
          onChange={(e) =>
            valueChange({
              stop: {
                kind: e.target.value,
                max_items: spec.selector.value.stop?.max_items || 10000,
                ...(e.target.value === "blank_run" ? { count: 1 } : {}),
              },
            })
          }
        >
          <option value="explicit_areas">지정한 영역 끝</option>
          <option value="blank_run">연속 빈칸</option>
        </select>
      </label>
      {spec.selector.value.stop?.kind === "blank_run" && (
        <label>
          연속 빈칸 수
          <input
            type="number"
            min={1}
            max={100}
            value={spec.selector.value.stop.count || 1}
            onChange={(e) =>
              valueChange({
                stop: {
                  ...spec.selector.value.stop,
                  count: Number(e.target.value),
                },
              })
            }
          />
        </label>
      )}
      <div className="v2-grid two">
        <label>
          값 타입
          <select
            value={spec.value_spec.type || "text"}
            onChange={(e) =>
              setSpec((s) => ({
                ...s,
                value_spec: { ...s.value_spec, type: e.target.value },
              }))
            }
          >
            {["text", "decimal", "boolean", "date", "datetime"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          목표 단위
          <input
            value={spec.value_spec.unit || ""}
            onChange={(e) =>
              setSpec((s) => ({
                ...s,
                value_spec: { ...s.value_spec, unit: e.target.value || null },
              }))
            }
          />
        </label>
      </div>
      <Presets
        value={spec.value_spec.normalization || { operation: "identity" }}
        onChange={(normal) =>
          setSpec((s) => ({
            ...s,
            value_spec: { ...s.value_spec, normalization: normal },
          }))
        }
      />
      <h3>연결 개념</h3>
      <form
        className="v2-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query);
        }}
      >
        <input
          aria-label="연결 개념 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="개념 · 동의어"
        />
        <button>검색</button>
      </form>
      <label>
        개념
        <select value={concept} onChange={(e) => setConcept(e.target.value)}>
          <option value="">선택하세요</option>
          {concept &&
            !concepts.data?.items.some((c) => c.concept_id === concept) && (
              <option value={concept}>{concept}</option>
            )}
          {concepts.data?.items.map((c) => (
            <option key={c.concept_id} value={c.concept_id}>
              {c.name} · L{c.level}
            </option>
          ))}
        </select>
      </label>
      <Pager page={concepts} />
      <details className="v2-details">
        <summary>원본 표현으로 동의어 후보 찾기</summary>
        <form
          className="v2-inline"
          onSubmit={(e) => {
            e.preventDefault();
            setTerm(alias);
          }}
        >
          <input
            aria-label="동의어 표현"
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
          />
          <button>후보 조회</button>
        </form>
        <State
          resource={aliases}
          empty="동일 표현의 등록된 동의어가 없습니다. 개념 검색으로 직접 연결하세요."
        />
        {aliases.data?.items.map((c, i) => (
          <button
            className="v2-list-item"
            key={i}
            onClick={() => setConcept(c.concept_id)}
          >
            {c.name} · {c.context_key}
          </button>
        ))}
        <Pager page={aliases} />
      </details>
      <details
        className="v2-details"
        onToggle={(e) => {
          if (e.currentTarget.open) setAdvanced(JSON.stringify(spec, null, 2));
        }}
      >
        <summary>업무키·정규화·상대 범위 세부 설정</summary>
        <textarea
          className="v2-code"
          aria-label="매핑 세부 JSON"
          rows={16}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
        <button
          onClick={() => {
            try {
              const next = JSON.parse(advanced);
              if (
                !next.selector?.key ||
                !next.selector?.value ||
                !next.value_spec
              )
                throw new Error("키·값·타입 정의가 필요합니다.");
              setSpec(next);
              setError("");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          편집기에 반영
        </button>
      </details>
      <label>
        저장 상태
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="proposed">검수 대기</option>
          <option value="approved">승인</option>
          <option value="rejected">반려</option>
        </select>
      </label>
      <label>
        수정 사유
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button className="primary full" disabled={busy} onClick={save}>
        수정 버전 저장
      </button>
      <p className="v2-error" role="alert">
        {error}
      </p>
      <p className="v2-muted">
        저장 후 현재 추출 결과가 해제됩니다. 승인된 규칙으로 다시 추출하세요.
      </p>
      <RevisionHistory mapping={mapping} />
    </>
  );
}
