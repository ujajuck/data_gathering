// 4. 통합 DB — 3단계: ①데이터 선택(개념→양식→문서) ②스키마 확인
//    ③생성·다운로드. 생성된 DB는 .db/.csv 파일로 바로 내려받는다.
import { useEffect, useMemo, useState } from "react";
import { api, post } from "../lib/api";
import type { CartItem } from "../lib/api";
import { useStore } from "../lib/store";
import type { BuildResult, Proposal, SearchResult, SearchSource } from "../lib/types";

const ETC = "기타 (양식 미배정)";

// ① 데이터 선택 — 개념을 고르고 양식을 체크하면 그 양식의 문서 전체가 반영된다.
// 양식별 전처리(정규화/원값)와 문서별 가감 지원. 검토 대기 소스는 승인 전까지 제외.
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
      <h4 style={{ margin: "0 0 4px" }}>① 데이터 선택</h4>
      <div className="sub" style={{ marginBottom: 8 }}>
        개념을 고르고 양식을 체크하세요 — 양식에 포함된 모든 문서가 자동으로
        담깁니다. 다른 개념을 골라 계속 추가할 수 있습니다.</div>
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

  const build = async () => {
    if (!proposal || !proposal.fields.filter((f) => f.sources > 0).length) {
      setBuildStatus("사용 가능한 소스가 없습니다 — 검토 대기 항목은 승인 후 포함됩니다.");
      return;
    }
    const safeName = name.replace(/[^A-Za-z0-9_]/g, "_");
    setBuilding(true);
    setBuildStatus("생성 중…");
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
      setBuildStatus("");
      setBuilt(true);
      setResult(r);
    } catch (e: any) {
      setBuildStatus(`생성 실패: ${e.message}`);
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
            <div className="title">통합 DB 만들기</div>
            <div className="sub">
              ① 데이터 선택 → ② 스키마 확인 → ③ 생성·다운로드 세 단계입니다.</div>
            <MergePicker />
            <div className="schemaCard">
              <h4 style={{ margin: "0 0 4px" }}>② 스키마 확인</h4>
              <div className="sub" style={{ marginBottom: 8 }}>
                선택한 데이터가 결과 DB의 컬럼(개념 단위)으로 묶였습니다.
                컬럼 이름만 다듬으면 됩니다.</div>
              <div style={{ marginBottom: 8 }}>
                {Object.entries(byConcept).map(([cid, n]) => (
                  <span key={cid} className="badge blue" style={{ margin: "2px 3px" }}>
                    {cid} · {n}{" "}
                    <button style={{ border: 0, background: "none", color: "var(--red)",
                      cursor: "pointer" }} title="이 개념 전체 빼기"
                      onClick={() => s.saveCart(cart.filter((x) =>
                        (x.concept_id || "(미매핑)") !== cid))}>✕</button>
                  </span>
                ))}
              </div>
              <table className="table">
                <thead><tr>
                  <th>결과 컬럼 이름</th><th>개념</th><th>위치 수</th>
                  <th>처리</th><th>상태</th></tr></thead>
                <tbody>
                  {proposal && cart.length ? proposal.fields.map((f, i) => (
                    <tr key={`${f.concept_id}-${i}`}>
                      <td><input value={f.field_name}
                        style={{ border: "1px solid var(--line)", borderRadius: 6,
                          padding: "4px 6px", width: 150 }}
                        onChange={(e) => setProposal((p) => p && ({ ...p,
                          fields: p.fields.map((x, j) =>
                            j === i ? { ...x, field_name: e.target.value } : x) }))} /></td>
                      <td>{f.concept_name}
                        {f.target_unit ? <span className="muted"> · {f.target_unit}</span> : null}</td>
                      <td>{f.sources}</td>
                      <td className="muted" style={{ fontSize: 11 }}>{f.note}</td>
                      <td style={{ color: f.status === "검토" ? "var(--amber)" : "var(--green)" }}>
                        {f.status}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={5} className="empty">
                      아직 비어 있습니다 — 위 ①에서 개념을 고르고 양식을 체크하세요.
                      (원본 데이터 화면의 '이 Source 포함'으로도 담을 수 있습니다)</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <aside className="panel pad">
          <div className="kicker">STEP ③</div>
          <div className="title">생성 · 다운로드</div>
          <div className="metricGrid">
            <div className="metric"><span>선택 위치</span><b>{cart.length}</b></div>
            <div className="metric"><span>대상 문서</span>
              <b>{new Set(cart.map((x) => x.document)).size}</b></div>
          </div>
          <div style={{ marginTop: 11 }}>
            <label className="muted" style={{ fontSize: 12 }}>DB 이름 (영문/숫자/_)</label>
            <input className="search" style={{ margin: "5px 0" }} value={dbName}
              onChange={(e) => setDbName(e.target.value)} />
          </div>
          <button className="primary w100" style={{ marginTop: 8 }}
            disabled={building || !cart.length}
            onClick={build}>{built ? "다시 생성 (새 버전)" : "DB 생성"}</button>
          <button className="secondary w100" style={{ marginTop: 8 }}
            onClick={() => { s.saveCart([]); setResult(null); setBuildStatus(""); setBuilt(false); }}>
            선택 비우기</button>
          <div className="status">{buildStatus}</div>
          {result && (
            <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
              <div className="kicker">생성 완료</div>
              <div className="sub">
                <b style={{ color: "var(--blue)" }}>{result.table}</b> · {result.row_count}행 ·
                출처 추적 {result.lineage.edges}셀 / {result.lineage.documents}문서</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <a className="primary w100" style={{ textAlign: "center",
                  textDecoration: "none", padding: "8px 0", borderRadius: 8,
                  display: "block" }}
                  href={`/api/build/${result.build_id}/download`}>
                  ⬇ DB 파일 (.db)</a>
                <a className="secondary w100" style={{ textAlign: "center",
                  textDecoration: "none", padding: "8px 0", borderRadius: 8,
                  display: "block", border: "1px solid var(--line)" }}
                  href={`/api/build/${result.build_id}/download?format=csv`}>
                  ⬇ CSV</a>
              </div>
              {result.build_report.warnings.length > 0 && (
                <div className="warn">
                  {result.build_report.warnings.map((w, i) => (
                    <div key={i}>⚠ {w.field ? `${w.field}: ${w.reason}`
                      : `${w.column || ""} ${w.from || ""}→${w.to || ""} ${w.cells || ""}건 미변환`}</div>
                  ))}
                </div>
              )}
              {result.schema.some((x) => x.included === false) && (
                <table className="table" style={{ marginTop: 8 }}>
                  <thead><tr><th>컬럼</th><th>포함</th></tr></thead>
                  <tbody>
                    {result.schema.map((x) => (
                      <tr key={x.field}>
                        <td>{x.field}</td>
                        <td>{x.included === false
                          ? <span style={{ color: "var(--red)" }}>제외됨</span> : "✓"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="kicker" style={{ marginTop: 10 }}>미리보기 (5행)</div>
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
