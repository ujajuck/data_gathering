import { useEffect, useRef, useState } from "react";
import { api, Pager, State, useData, useNavigation, usePage } from "./client";
import type { Row } from "./client";
import Suggestions from "./Suggestions";

const CLEARED = {
  document: "",
  version: "",
  sheet: "",
  application: "",
  mapping: "",
  series: "",
  item: "",
};

// 파일 분석 표에서 고른 문서의 상세(등록 버전 · 시트 · 문서군 제안 · 템플릿 연결)를 우측 드로어로 보여준다.
// aria-modal·inert는 쓰지 않는다: 뒤의 표와 검수 큐는 드로어가 열린 동안에도 조작할 수 있어야 한다.
export default function DocumentDrawer() {
  const { route, go } = useNavigation();
  const open = !!route.document;
  const versions = usePage(
    open ? "/documents/" + route.document + "/versions" : null,
  );
  const sheets = usePage(
    open && route.version ? "/versions/" + route.version + "/sheets" : null,
  );
  const panel = useRef<HTMLElement>(null);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") goRef.current(CLEARED);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  const close = () => go(CLEARED);
  return (
    <>
      <div className="v2-drawer-backdrop" onClick={close} aria-hidden="true" />
      <aside
        className="v2-drawer"
        role="dialog"
        aria-label="문서 상세"
        tabIndex={-1}
        ref={panel}
      >
        <div className="v2-card-head v2-drawer-head">
          <h2>문서 상세</h2>
          <div className="v2-inline">
            {route.version && (
              <button type="button" onClick={() => go({ tab: "source" })}>
                원본 · 검수 열기 →
              </button>
            )}
            <button
              type="button"
              className="v2-drawer-close"
              aria-label="닫기"
              onClick={close}
            >
              ×
            </button>
          </div>
        </div>
        <section className="v2-drawer-section">
          <h3>등록 버전</h3>
          <State resource={versions} />
          <div className="v2-list">
            {versions.data?.items.map((v) => (
              <button
                className={
                  "v2-list-item " +
                  (v.document_version_id === route.version ? "selected" : "")
                }
                key={v.document_version_id}
                onClick={() =>
                  go({
                    version: v.document_version_id,
                    sheet: "",
                    application: "",
                    mapping: "",
                    series: "",
                    item: "",
                  })
                }
              >
                <span>
                  <strong>
                    {v.filename} · v{v.revision_no}
                  </strong>
                  <small>
                    {v.captured_at} · {v.author || "작성자 미상"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <Pager page={versions} />
        </section>
        <section className="v2-drawer-section">
          <h3>시트 선택</h3>
          <State resource={sheets} />
          {sheets.data?.items.map((s) => (
            <button
              className="v2-chip"
              key={s.sheet_id}
              onClick={() => go({ tab: "source", sheet: s.sheet_id })}
            >
              {s.name} · {s.estimated_rows || "?"}행
            </button>
          ))}
          <Pager page={sheets} />
        </section>
        <Suggestions />
        <AssignTemplate />
      </aside>
    </>
  );
}

export function AssignTemplate() {
  const { route, go, changed } = useNavigation();
  const templates = usePage("/templates");
  const sheets = usePage(
    route.version ? "/versions/" + route.version + "/sheets" : null,
  );
  const [selected, setSelected] = useState("");
  const detail = useData(selected ? "/template-versions/" + selected : null);
  const [bindings, setBindings] = useState<Record<string, string[]>>({});
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function assign() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/applications", {
        version_id: route.version,
        template_version_id: selected,
        bindings,
        approved,
      });
      changed();
      go({
        tab: "source",
        application: result.application_id,
        mapping: "",
        series: "",
        item: "",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="v2-details">
      <summary>+ 이 문서 버전에 템플릿 연결</summary>
      <p>
        같은 시트·위치에도 여러 템플릿을 연결할 수 있습니다. 시트 역할마다 실제
        시트를 선택하세요.
      </p>
      <label>
        템플릿
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setBindings({});
            setApproved(false);
          }}
        >
          <option value="">템플릿 선택</option>
          {templates.data?.items.map((t) => (
            <option value={t.template_version_id} key={t.template_id}>
              {t.name} · v{t.revision_no}
            </option>
          ))}
        </select>
      </label>
      <State
        resource={templates}
        empty="템플릿 탭에서 먼저 템플릿을 만드세요."
      />
      <Pager page={templates} />
      <State resource={detail} />
      {detail.data &&
        Object.entries(detail.data.definition.sheet_roles).map(
          ([role, value]) => (
            <div className="v2-binding" key={role}>
              <label>
                {role} · {(value as Row).cardinality || "one"}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      setBindings((b) => ({
                        ...b,
                        [role]:
                          (value as Row).cardinality === "many"
                            ? [...new Set([...(b[role] || []), e.target.value])]
                            : [e.target.value],
                      }));
                  }}
                >
                  <option value="">시트 연결</option>
                  {sheets.data?.items.map((s) => (
                    <option value={s.sheet_id} key={s.sheet_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {(bindings[role] || []).map((id) => (
                <button
                  className="v2-chip"
                  key={id}
                  onClick={() =>
                    setBindings((b) => ({
                      ...b,
                      [role]: b[role].filter((x) => x !== id),
                    }))
                  }
                >
                  {sheets.data?.items.find((s) => s.sheet_id === id)?.name ||
                    id.slice(0, 8)}{" "}
                  ×
                </button>
              ))}
            </div>
          ),
        )}
      {selected && (
        <>
          <Pager page={sheets} />
          <label className="v2-check">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            선택한 시트에서 키·값 영역과 연결 개념을 확인했습니다
          </label>
          <button
            className="primary"
            disabled={busy || !route.version}
            onClick={assign}
          >
            {approved ? "승인하여 연결" : "검수 대기로 연결"}
          </button>
        </>
      )}
      <p className="v2-error" role="alert">
        {error}
      </p>
    </details>
  );
}
