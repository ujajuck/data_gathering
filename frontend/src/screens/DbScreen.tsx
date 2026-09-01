// 4. 통합 DB — 개념 → 양식(양식의 문서 자동 반영) → 양식별 전처리/개별 문서
//    가감으로 머지 대상을 만들고, 스키마 제안을 받아 DB를 생성한다.
import { useEffect, useMemo, useState } from "react";
import { api, post, ROLE_BADGE } from "../lib/api";
import type { CartItem } from "../lib/api";
import { useStore } from "../lib/store";
import type { BuildResult, Proposal, SearchResult, SearchSource } from "../lib/types";

const ETC = "기타 (양식 미배정)";

// 개념 → 양식 → 문서 선택 마법사. 양식 체크 = 그 양식 소속 문서의 사용 가능
// 소스 전부를 묶음에 반영. 양식별 전처리(정규화/원값 유지)와 개별 문서
// 추가/제거를 지원한다. 검토 대기(REVIEW_REQUIRED) 소스는 승인 전까지 제외.
function MergePicker() {
  const s = useStore();
  const [concept, setConcept] = useState("");
  const [res, setRes] = useState<SearchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRes(null);
    setErr(null);
    if (!concept) return;
    let dead = false;
    api(`/api/search?concept=${encodeURIComponent(concept)}`)
      .then((r) => { if (!dead) setRes(r); })
      .catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [concept]);

  const formOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of s.files)
      if (f.template_name)
        m.set(f.document_id, `${f.template_name} v${f.template_version}`);
    return m;
  }, [s.files]);

  const groups = useMemo(() => {
    if (!res) return [];
    const by = new Map<string, { docs: Map<string, SearchSource[]>; review: number }>();
    for (const src of res.sources) {
      const label = formOf.get(src.document_id) || ETC;
      const g = by.get(label) || { docs: new Map(), review: 0 };
      if (src.status === "REVIEW_REQUIRED") g.review += 1;
      else {
        const list = g.docs.get(src.document_id) || [];
        list.push(src);
        g.docs.set(src.document_id, list);
      }
      by.set(label, g);
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a === ETC ? 1 : b === ETC ? -1 : a.localeCompare(b, "ko")))
      .map(([label, g]) => ({ label, ...g,
        nodeIds: [...g.docs.values()].flat().map((x) => x.node_id) }));
  }, [res, formOf]);

  const toCartItem = (src: SearchSource, raw: boolean): CartItem => ({
    node_id: src.node_id, concept_id: concept, header: src.header,
    document: src.document, sheet: src.sheet,
    range: (src.locator || "").split("!").pop() || "", role: null, raw });

  const cart = s.cartItems();               // cartCount 변경 시 리렌더로 최신화
  const inCart = new Set(cart.map((x) => x.node_id));

  const addSources = (sources: SearchSource[], raw: boolean) => {
    const add = sources.filter((x) => !inCart.has(x.node_id))
      .map((x) => toCartItem(x, raw));
    s.saveCart([...cart, ...add]);
  };
  const removeNodes = (nodeIds: string[]) => {
    const drop = new Set(nodeIds);
    s.saveCart(cart.filter((x) => !drop.has(x.node_id)));
  };

  return (
    <div className="schemaCard">
      <h4 style={{ margin: "0 0 4px" }}>머지 대상 선택 — 개념 → 양식 → 문서</h4>
      <div className="sub" style={{ marginBottom: 8 }}>
        개념을 고르고 양식을 체크하면 그 양식에 포함된 모든 문서가 자동
        반영됩니다. 양식별 전처리를 정하거나, 펼쳐서 문서를 개별 추가/제거하세요.</div>
      <div className="editForm" style={{ maxWidth: 420 }}>
        <select value={concept} onChange={(e) => setConcept(e.target.value)}>
          <option value="">— 개념 선택 —</option>
          {s.concepts.map((c) => (
            <option key={c.concept_id} value={c.concept_id}>
              {c.canonical_name} ({c.concept_id})</option>
          ))}
        </select>
      </div>
      {err && <div className="empty">{err}</div>}
      {concept && res && !groups.length && (
        <div className="empty">이 개념에 매핑된 사용 가능 소스가 없습니다</div>
      )}
      {groups.map((g) => {
        const carted = g.nodeIds.filter((id) => inCart.has(id));
        const all = carted.length === g.nodeIds.length && g.nodeIds.length > 0;
        const some = carted.length > 0 && !all;
        const cartedItems = cart.filter((x) => carted.includes(x.node_id));
        const prep = cartedItems.length && cartedItems.every((x) => x.raw) ? "raw" : "auto";
        const isEtc = g.label === ETC;
        return (
          <div key={g.label} className="dkgCard" style={{ cursor: "default",
            borderLeft: `4px solid ${isEtc ? "var(--line)" : "var(--purple)"}` }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center",
                cursor: "pointer", fontWeight: 700,
                color: isEtc ? "var(--muted)" : "var(--purple)" }}>
                <input type="checkbox" checked={all}
                  ref={(el) => { if (el) el.indeterminate = some; }}
                  onChange={() => all ? removeNodes(g.nodeIds)
                    : addSources([...g.docs.values()].flat(), prep === "raw")} />
                ▣ {g.label}
              </label>
              <span className="muted" style={{ fontSize: 11 }}>
                문서 {g.docs.size} · 위치 {g.nodeIds.length}
                {g.review ? ` · 검토 대기 ${g.review} 제외` : ""} · 반영 {carted.length}</span>
              <select className="editForm" value={prep} disabled={!carted.length}
                title="양식별 전처리 — 이 양식에서 반영된 위치들에 적용"
                style={{ marginLeft: "auto", marginTop: 0, width: 190,
                  border: "1px solid var(--line)", borderRadius: 8,
                  padding: "4px 6px", fontSize: 11 }}
                onChange={(e) => {
                  const raw = e.target.value === "raw";
                  const ids = new Set(carted);
                  s.saveCart(cart.map((x) =>
                    ids.has(x.node_id) ? { ...x, raw } : x));
                }}>
                <option value="auto">전처리: 자동 정규화 (단위→기준)</option>
                <option value="raw">전처리: 원값 유지 (변환 생략)</option>
              </select>
              <button className="secondary" style={{ padding: "4px 8px", fontSize: 11 }}
                onClick={() => setOpen((m) => ({ ...m, [g.label]: !m[g.label] }))}>
                {open[g.label] ? "접기" : "문서별 조정"}</button>
            </div>
            {open[g.label] && (
              <div style={{ marginTop: 6 }}>
                {[...g.docs.entries()].map(([docId, sources]) => {
                  const docCarted = sources.filter((x) => inCart.has(x.node_id));
                  const docAll = docCarted.length === sources.length;
                  return (
                    <label key={docId} className="fileRow"
                      style={{ display: "block", paddingLeft: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={docAll}
                        ref={(el) => {
                          if (el) el.indeterminate = docCarted.length > 0 && !docAll;
                        }}
                        onChange={() => docAll
                          ? removeNodes(sources.map((x) => x.node_id))
                          : addSources(sources, prep === "raw")} />{" "}
                      <b>▤ {sources[0].document}</b>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {" "}· 위치 {sources.length} · 반영 {docCarted.length}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function DbScreen() {
  const s = useStore();
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [dbName, setDbName] = useState("experiment_result");
  const [buildStatus, setBuildStatus] = useState("");
  const [result, setResult] = useState<BuildResult | null>(null);
  const [building, setBuilding] = useState(false);
  const [built, setBuilt] = useState(false);

  useEffect(() => {
    if (s.screen !== "db") return;
    const c = s.cartItems();
    if (!c.length) { setProposal(null); return; }
    let dead = false;
    post("/api/proposal", { node_ids: c.map((x) => x.node_id) })
      .then((p: Proposal) => {
        if (dead) return;
        if (p.stale_node_ids && p.stale_node_ids.length) {
          const stale = new Set(p.stale_node_ids);
          s.saveCart(c.filter((x) => !stale.has(x.node_id)));
          setBuildStatus(`⚠ 재적재로 사라진 위치 ${stale.size}건을 묶음에서 제거했습니다.`);
        }
        setProposal(p);
      })
      .catch((e) => { if (!dead) setBuildStatus(e.message); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.screen, s.cartCount]);

  const cart = s.cartItems();
  const byConcept: Record<string, number> = {};
  cart.forEach((x) => {
    const k = x.concept_id || "(미매핑)";
    byConcept[k] = (byConcept[k] || 0) + 1;
  });

  const name = dbName.trim() || "result";
  const schemaTree = proposal
    ? [name,
      ...proposal.fields.map((f, i) =>
        `${i === proposal.fields.length - 1 ? "└─" : "├─"} ${f.field_name} ${(f.type || "text").toUpperCase()}${f.target_unit ? " · " + f.target_unit : ""}`),
      "├─ _source_document_id", "├─ _source_sheet", "└─ _source_locator"].join("\n")
    : "결과 스키마가 여기 표시됩니다";

  const build = async () => {
    if (!proposal || !proposal.fields.filter((f) => f.sources > 0).length) {
      setBuildStatus("사용 가능한 소스가 없습니다 — 검토 대기 항목은 승인 후 포함됩니다.");
      return;
    }
    const safeName = name.replace(/[^A-Za-z0-9_]/g, "_");
    setBuilding(true);
    setBuildStatus("BUILDING…");
    try {
      const fields = proposal.fields.filter((f) => f.sources > 0);
      const body = {
        name: safeName,
        fields: fields.map((f) => ({
          name: f.field_name.replace(/[^A-Za-z0-9_]/g, "_") || f.concept_id,
          concept: f.concept_id, unit: f.target_unit, type: f.type })),
        include_nodes: Object.fromEntries(fields.map((f) => [
          f.field_name.replace(/[^A-Za-z0-9_]/g, "_") || f.concept_id, f.node_ids])),
        // 양식별 전처리 '원값 유지' — 해당 위치는 단위 변환을 생략한다
        raw_node_ids: cart.filter((x) => x.raw).map((x) => x.node_id),
      };
      const r: BuildResult = await post("/api/build", body);
      setBuildStatus(`✓ ${r.status} — 재실행하면 새 버전이 생성됩니다`);
      setBuilt(true);
      setResult(r);
    } catch (e: any) {
      setBuildStatus(`실패: ${e.message}`);
    }
    setBuilding(false);
  };

  const previewCols = result && result.preview.length
    ? Object.keys(result.preview[0]).filter((k) => !k.startsWith("_")) : [];

  return (
    <section className={`screen${s.screen === "db" ? " active" : ""}`}>
      <div className="builder">
        <div>
          <div className="panel pad">
            <div className="title">통합 DB Builder</div>
            <div className="sub">개념 → 양식 → 문서 순서로 머지 대상을 만들고, Row Context
              기준으로 묶은 스키마 제안에서 예외만 조정하세요.</div>
            <MergePicker />
            <div className="schemaCard">
              <h4 style={{ margin: "0 0 8px" }}>선택된 묶음</h4>
              <div style={{ marginBottom: 8 }}>
                {Object.keys(byConcept).length ? Object.entries(byConcept).map(([cid, n]) => (
                  <span key={cid} className="badge blue" style={{ margin: "2px 3px" }}>
                    {cid} · {n}{" "}
                    <button style={{ border: 0, background: "none", color: "var(--red)",
                      cursor: "pointer" }}
                      onClick={() => s.saveCart(cart.filter((x) =>
                        (x.concept_id || "(미매핑)") !== cid))}>✕</button>
                  </span>
                )) : <span className="empty">비어 있음</span>}
              </div>
              <table className="table">
                <thead><tr>
                  <th>필드</th><th>Domain Node</th><th>역할</th>
                  <th>Source</th><th>처리</th><th>상태</th></tr></thead>
                <tbody>
                  {proposal && cart.length ? proposal.fields.map((f, i) => (
                    <tr key={`${f.concept_id}-${i}`}>
                      <td><input value={f.field_name}
                        style={{ border: "1px solid var(--line)", borderRadius: 6,
                          padding: "4px 6px", width: 140 }}
                        onChange={(e) => setProposal((p) => p && ({ ...p,
                          fields: p.fields.map((x, j) =>
                            j === i ? { ...x, field_name: e.target.value } : x) }))} /></td>
                      <td>{f.concept_name}</td>
                      <td><span className={`badge ${ROLE_BADGE[f.role || ""] || ""}`}>
                        {f.role || ""}</span></td>
                      <td>{f.sources}</td>
                      <td>{f.note}</td>
                      <td style={{ color: f.status === "검토" ? "var(--amber)" : "var(--green)" }}>
                        {f.status}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={6} className="empty">
                      원본 데이터 화면에서 '이 Source 포함' 또는 개념 탐색의 '통합 DB 대상에
                      추가'로 담으세요</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flow">
              <div className="block">Source Select</div><span className="arrow">→</span>
              <div className="block">Schema Align</div><span className="arrow">→</span>
              <div className="block">Unit Normalize</div><span className="arrow">→</span>
              <div className="block">Type Cast</div><span className="arrow">→</span>
              <div className="block">Union / Join</div><span className="arrow">→</span>
              <div className="block">Validation</div>
            </div>
          </div>
        </div>
        <aside className="panel pad">
          <div className="kicker">OUTPUT</div>
          <div className="title">생성 결과</div>
          <div className="metricGrid">
            <div className="metric"><span>선택 위치</span><b>{cart.length}</b></div>
            <div className="metric"><span>대상 문서</span>
              <b>{new Set(cart.map((x) => x.document)).size}</b></div>
          </div>
          <div style={{ marginTop: 11 }}>
            <label className="muted" style={{ fontSize: 12 }}>결과 이름</label>
            <input className="search" style={{ margin: "5px 0" }} value={dbName}
              onChange={(e) => setDbName(e.target.value)} />
          </div>
          <div className="code">{schemaTree}</div>
          <button className="primary w100" style={{ marginTop: 11 }} disabled={building}
            onClick={build}>{built ? "DB 다시 생성 (새 버전)" : "DB 생성 및 반환"}</button>
          <button className="secondary w100" style={{ marginTop: 8 }}
            onClick={() => { s.saveCart([]); setResult(null); setBuildStatus(""); }}>
            묶음 비우기</button>
          <div className="status">{buildStatus}</div>
          {result && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="kicker">RESULT</div>
              <div className="sub">
                <b style={{ color: "var(--blue)" }}>{result.table}</b> · {result.row_count} rows ·
                Lineage {result.lineage.edges}셀/{result.lineage.documents}문서<br />
                artifact: <code style={{ fontSize: 11 }}>{result.artifact}</code>
              </div>
              {result.build_report.warnings.length > 0 && (
                <div className="warn">
                  {result.build_report.warnings.map((w, i) => (
                    <div key={i}>⚠ {w.field ? `${w.field}: ${w.reason}`
                      : `${w.column || ""} ${w.from || ""}→${w.to || ""} ${w.cells || ""}건 미변환`}</div>
                  ))}
                </div>
              )}
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>필드</th><th>Concept</th><th>단위</th><th>포함</th></tr></thead>
                <tbody>
                  {result.schema.map((x) => (
                    <tr key={x.field}>
                      <td>{x.field}</td><td>{x.concept}</td><td>{x.unit || "—"}</td>
                      <td>{x.included === false
                        ? <span style={{ color: "var(--red)" }}>제외됨</span> : "✓"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="kicker" style={{ marginTop: 10 }}>PREVIEW</div>
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead><tr>{previewCols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>
                    {result.preview.map((row, i) => (
                      <tr key={i}>{previewCols.map((c) => (
                        <td key={c}>{String(row[c] ?? "")}</td>
                      ))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
