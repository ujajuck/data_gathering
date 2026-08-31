// 4. 통합 DB — 담은 Source 묶음으로 스키마 제안을 받고, 조정 후 DB를 생성한다.
//    web_kg renderCartList/refreshProposal/buildDb 포트.
import { useEffect, useState } from "react";
import { post, ROLE_BADGE } from "../lib/api";
import { useStore } from "../lib/store";
import type { BuildResult, Proposal } from "../lib/types";

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
            <div className="sub">선택한 Domain Node와 Source들을 Row Context 기준으로 묶어
              스키마를 제안합니다. 예외만 조정하세요.</div>
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
                      원본 데이터 화면에서 '이 Source 포함' 또는 KG 탐색의 '통합 DB 대상에
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
