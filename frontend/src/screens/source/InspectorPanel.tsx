// Source Inspector (MAPPING 패널) — 매핑 근거, VIEWER SOURCE, PARSING TEMPLATE
// provenance, 값 미리보기, 승인/반려/재매핑/통합 포함. web_kg openInspector 포트.
import React, { useEffect, useState } from "react";
import { api, post } from "../../lib/api";
import { useStore } from "../../lib/store";
import type { SourceDetail } from "../../lib/types";

interface Props {
  nodeId: string | null;
  onAfterReview: (nodeId: string) => void;   // 승인/반려 후 시트·검수 목록 갱신
  onAfterRemap: (nodeId: string) => void;    // 재매핑 후 시트 갱신
}

export default function InspectorPanel({ nodeId, onAfterReview, onAfterRemap }: Props) {
  const s = useStore();
  const [d, setD] = useState<SourceDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [selConcept, setSelConcept] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => { setStatus(""); }, [nodeId]);

  useEffect(() => {
    setErr(null);
    if (!nodeId) { setD(null); return; }
    let dead = false;
    api(`/api/source/${encodeURIComponent(nodeId)}`)
      .then((r) => { if (!dead) { setD(r); setSelConcept(r.mapping?.concept_id || ""); } })
      .catch((e) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, [nodeId, refreshKey]);

  if (!nodeId) return (
    <>
      <div className="kicker">MAPPING</div>
      <div className="empty">Overlay 영역(테두리 셀)이나 원본 위치를 클릭하세요</div>
    </>
  );
  if (err) return <><div className="kicker">MAPPING</div><div className="empty">{err}</div></>;
  if (!d) return <><div className="kicker">MAPPING</div><div className="empty">불러오는 중…</div></>;

  const inCart = s.cartItems().some((x) => x.node_id === nodeId);
  const isReview = d.mapping && d.mapping.status === "REVIEW_REQUIRED";
  const unmapped = !d.mapping || !d.mapping.concept_id || d.mapping.status === "UNMAPPED";
  const sourceText = (src?: { sheet?: string; range?: string } | null) =>
    src ? `${src.sheet || d.sheet}!${src.range || "동적 탐색"}` : "—";
  const ps = d.parsing_source;
  const pt = d.parsing_template;

  const act = (action: "approve" | "reject") => async () => {
    if (!d.mapping) return;
    try {
      await post("/api/review", { mapping_id: d.mapping.mapping_id, action });
      setStatus(action === "approve" ? "✓ 승인되었습니다."
        : ("반려되었습니다." + (d.mapping.method === "recipe"
          ? " 이 양식 전체를 고치려면: 매핑 수정 후 레시피 재저장 → reset_auto 재크롤링." : "")));
      s.setNodeSearch(null);           // 소스 목록의 ⚠/매핑 라벨 stale 방지
      s.loadFiles().catch(() => {});
      onAfterReview(nodeId);
      setRefreshKey((k) => k + 1);
    } catch (e: any) { setStatus(e.message); }
  };

  const remap = async () => {
    if (!selConcept) { setStatus("개념을 먼저 선택하세요."); return; }
    setBusy(true);
    try {
      await post("/api/remap", { node_id: nodeId, concept_id: selConcept });
      setStatus(`✓ ${selConcept} 로 매핑을 확정했습니다.`);
      s.setNodeSearch(null);           // 소스 목록/카운트 stale 방지
      onAfterRemap(nodeId);
      setRefreshKey((k) => k + 1);
    } catch (e: any) { setStatus(e.message); }
    setBusy(false);
  };

  const stat = d.mapping?.status;
  const statCls = stat === "REVIEW_REQUIRED" ? "amber"
    : (stat === "AUTO_APPROVED" || stat === "APPROVED") ? "green"
    : stat ? "red" : "";

  return (
    <>
      <div className="kicker">SOURCE INSPECTOR</div>
      {/* 무엇이 어디서 뽑혔는지가 주인공 — 키 헤더 → 개념 */}
      <div className="title">{d.concept_name || "미매핑"}</div>
      <div className="sub">
        키 헤더 <b>‘{d.header}’</b> ({d.sheet}!{d.range})에서 추출
        {d.unit ? ` · 단위 ${d.unit}` : ""}</div>
      <div style={{ marginTop: 7, display: "flex", gap: 4, flexWrap: "wrap" }}>
        {d.role && <span className="badge">{d.role}</span>}
        {d.mapping && (
          <span className={`badge ${statCls}`}>{d.mapping.status} · {d.mapping.confidence}</span>
        )}
        {d.mapping?.method === "recipe" && <span className="badge blue">레시피</span>}
      </div>
      {isReview && (
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <button className="primary" style={{ flex: 1 }} onClick={act("approve")}>승인</button>
          <button className="secondary" style={{ flex: 1 }} onClick={act("reject")}>반려</button>
        </div>
      )}

      {/* 어떤 키에 어떤 값이 뽑혔는지 — 추출 결과 표 */}
      <div style={{ marginTop: 14 }} className="kicker">
        추출된 키 → 값 ({d.values.length}
        {typeof d.value_count === "number" && d.value_count > d.values.length
          ? ` / 총 ${d.value_count}` : ""}건)</div>
      {d.values.length ? (
        <div style={{ maxHeight: "36vh", overflowY: "auto", marginTop: 6,
          border: "1px solid var(--line)", borderRadius: 8 }}>
          <table className="table">
            <thead><tr>
              <th>키</th><th style={{ textAlign: "right" }}>값</th>
              {d.unit ? <th>단위</th> : null}<th>셀</th></tr></thead>
            <tbody>
              {d.values.map((v, i) => (
                <tr key={i}>
                  <td>{v.key ?? <span className="muted">#{i + 1}</span>}</td>
                  <td style={{ textAlign: "right", fontWeight: 700 }}>{String(v.value)}</td>
                  {d.unit ? <td className="muted">{d.unit}</td> : null}
                  <td className="muted" style={{ fontSize: 11 }}>{v.cell || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <div className="empty">추출된 값이 없습니다</div>}
      {typeof d.value_count === "number" && d.value_count > d.values.length && (
        <div className="sub" style={{ fontSize: 11 }}>
          표시는 {d.values.length}건까지 — 전체는 통합 DB 빌드 결과에서 확인하세요.</div>
      )}

      <div style={{ marginTop: 12 }} className="kicker">DOMAIN CONCEPT</div>
      <select value={unmapped && !selConcept ? "" : selConcept}
        onChange={(e) => setSelConcept(e.target.value)}>
        <option value="" disabled>— 개념 선택 —</option>
        {s.concepts.map((c) => (
          <option key={c.concept_id} value={c.concept_id}>
            {c.canonical_name} ({c.concept_id})</option>
        ))}
      </select>
      <button className="secondary w100" style={{ marginTop: 8 }} disabled={busy}
        onClick={remap}>매핑 수정</button>
      <button className="primary w100" style={{ marginTop: 8 }}
        disabled={inCart || unmapped}
        onClick={() => {
          if (!d.mapping) return;
          s.addCart({ node_id: nodeId, concept_id: d.mapping.concept_id, header: d.header,
            document: d.document, sheet: d.sheet, range: d.range, role: d.role });
          setStatus("✓ 통합 DB 초안에 포함되었습니다.");
        }}>
        {inCart ? "✓ 이미 포함됨" : (unmapped ? "매핑 확정 후 포함 가능" : "이 Source 포함")}</button>
      <div className="status">{status}</div>

      {/* 판정 근거·출처 메타 — 필요할 때만 펼쳐 본다 */}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--muted)" }}>
          상세 정보 (판정 근거 · 문서 · 양식)</summary>
        <div className="kv">
          <strong>매핑 판정</strong>
          <p>방법: {d.mapping?.method || "—"}
            {d.mapping?.reason ? <><br />{d.mapping.reason}</> : null}</p>
        </div>
        <div className="kv">
          <strong>Row Context</strong>
          <p>인접 키: {(d.row_context.keys || []).join(", ") || "—"}<br />
            경로: {(d.row_context.header_path || []).join(" › ") || "—"}</p>
        </div>
        <div className="kv">
          <strong>문서</strong>
          <p>{d.document} · {d.document_version || "version 없음"} · Read only<br />
            DRM: {d.viewer ? d.viewer.drm_status : "미등록"} ·
            Render: {d.viewer ? d.viewer.render_status : "미등록"}</p>
        </div>
        <div className="kv">
          <strong>양식 (Parsing Template)</strong>
          {pt ? (
            <p>▣ {pt.template_name} v{pt.template_version} · {pt.status}<br />
              Mapping: {ps ? ps.mapping_source : "Template source 미연결"}
              {ps && ps.override_status ? ` · ${ps.override_status}` : ""}<br />
              Template Source: {sourceText(ps && ps.template_source)}<br />
              Effective Source: <b>{sourceText(ps && ps.effective_source)}</b>
              {ps && ps.override_reason ? <><br />사유: {ps.override_reason}</> : null}</p>
          ) : <p>이 Document Version에 배정된 양식이 없습니다.</p>}
        </div>
      </details>
    </>
  );
}
