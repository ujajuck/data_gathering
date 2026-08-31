// 3. 원본 데이터 — 좌측 원본 위치(검수 큐/노드 소스), 중앙 원본 충실 렌더
//    + Semantic Overlay, 우측 Source Inspector. web_kg renderSourceScreen/loadSheet 포트.
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../lib/store";
import type { OverlayItem, ReviewRow, SheetData } from "../lib/types";
import SheetGrid from "./source/SheetGrid";
import InspectorPanel from "./source/InspectorPanel";

export default function SourceScreen() {
  const s = useStore();
  const [docId, setDocId] = useState<string | null>(null);
  const [data, setData] = useState<SheetData | null>(null);
  const [allOverlay, setAllOverlay] = useState<OverlayItem[]>([]);
  const [ovErr, setOvErr] = useState("");
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [inspectorNode, setInspectorNode] = useState<string | null>(null);
  const [vmsg, setVmsg] = useState<string | null>(null);
  const [reviewRows, setReviewRows] = useState<ReviewRow[] | null>(null);
  const [reviewRefresh, setReviewRefresh] = useState(0);
  const [listErr, setListErr] = useState<string | null>(null);
  const [selLoc, setSelLoc] = useState<number | null>(null);
  const seqRef = useRef(0);
  const handledReq = useRef(0);

  const loadSheet = async (doc: string, sheet: string | null, focus?: string | null) => {
    const seq = ++seqRef.current;
    setVmsg("불러오는 중…");
    try {
      const d: SheetData = await api(`/api/sheet?doc=${encodeURIComponent(doc)}` +
        (sheet ? `&name=${encodeURIComponent(sheet)}` : ""));
      if (seq !== seqRef.current) return false;   // 추월됨 — 호출측 후속 동작도 중단
      let ov: OverlayItem[] = [], oe = "";
      try {
        ov = await api(`/api/overlay?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(d.sheet)}`);
      } catch (e: any) { oe = `Overlay 조회 실패: ${e.message.slice(0, 60)}`; }
      if (seq !== seqRef.current) return false;
      setDocId(doc);
      setData(d);
      setAllOverlay(ov);
      setOvErr(oe);
      setFocusNode(focus ?? null);
      setInspectorNode(focus ?? null);
      setVmsg(null);
      return true;
    } catch (e: any) {
      if (seq === seqRef.current) setVmsg(e.message);
      return false;
    }
  };

  // 다른 탭(파일/KG)에서 넘어온 열기 요청 처리
  useEffect(() => {
    const req = s.srcRequest;
    if (!req || req.seq === handledReq.current) return;
    handledReq.current = req.seq;
    loadSheet(req.doc, req.sheet, req.node)
      .then((ok) => { if (ok && req.node) setInspectorNode(req.node); })
      .catch((e) => setVmsg(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.srcRequest]);

  // 좌측 목록 데이터 — 검수 모드(§3.2 검토 큐) 또는 선택 노드의 소스 목록
  useEffect(() => {
    if (s.screen !== "source") return;
    setListErr(null);
    if (s.reviewDoc) {
      api(`/api/review?doc=${encodeURIComponent(s.reviewDoc)}`)
        .then(setReviewRows)
        .catch((e) => { setReviewRows([]); setListErr(e.message); });
      return;
    }
    setReviewRows(null);
    if (!s.selNode) return;
    if (s.nodeSearch && s.nodeSearch.concept.concept_id === s.selNode.id) return;
    api(`/api/search?concept=${encodeURIComponent(s.selNode.id)}`)
      .then((r) => s.setNodeSearch(r))
      .catch((e) => setListErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.screen, s.reviewDoc, s.selNode, s.nodeSearch, reviewRefresh]);

  useEffect(() => { setSelLoc(null); }, [s.reviewDoc, s.selNode]);

  const jumpTo = (documentId: string, locator: string | null, nodeId: string | null) => {
    const cut = (locator || "").lastIndexOf("!");
    const sheet = cut > 0 ? locator!.slice(0, cut) : null;
    loadSheet(documentId, sheet, nodeId)
      // 추월된(false) 호출의 인스펙터가 화면의 시트를 덮지 않게
      .then((ok) => { if (ok && nodeId) setInspectorNode(nodeId); })
      .catch((e) => setVmsg(e.message));
  };

  const g = s.selDkg ? s.dkgOf(s.selDkg) : undefined;
  const crumbParts: string[] = [];
  if (g) crumbParts.push(g.name);
  if (s.selNode) crumbParts.push(s.selNode.name);
  if (s.reviewDoc) {
    const f = s.files.find((x) => x.document_id === s.reviewDoc);
    crumbParts.push(`${f ? f.filename : ""} 검수`);
  }
  crumbParts.push("원본 데이터");

  const res = !s.reviewDoc && s.selNode &&
    s.nodeSearch && s.nodeSearch.concept.concept_id === s.selNode.id ? s.nodeSearch : null;

  const overlay = s.overlayEnabled ? allOverlay : [];
  const roles: Record<string, number> = {};
  allOverlay.forEach((o) => { roles[o.role] = (roles[o.role] || 0) + 1; });

  const reloadCurrent = (nodeId: string) => {
    if (docId && data) loadSheet(docId, data.sheet, nodeId).catch(() => {});
  };

  return (
    <section className={`screen${s.screen === "source" ? " active" : ""}`}>
      <div className="crumb"><b>전체 KG</b> › {crumbParts.join(" › ")}</div>
      <div className="excelLayout">
        <aside className="panel pad">
          <div className="kicker">SOURCE LOCATIONS</div>
          {s.reviewDoc ? (
            <>
              <div className="title">검수 대기 목록</div>
              <div className="sub">항목을 클릭해 원본을 확인하고 승인/반려하세요</div>
              <div className="srcList">
                {listErr && <div className="empty">{listErr}</div>}
                {reviewRows && reviewRows.length === 0 && !listErr && (
                  <div className="empty">검수 대기 항목이 없습니다 ✓</div>
                )}
                {(reviewRows || []).map((r, i) => (
                  <div key={r.node_id} className={`location${selLoc === i ? " sel" : ""}`}
                    onClick={() => { setSelLoc(i); jumpTo(r.document_id, r.locator, r.node_id); }}>
                    <b>{r.node_name}</b> → {r.concept_id || "?"}
                    <div className="sub">{r.filename} · {(r.locator || "").split("!").pop()} ·
                      {" "}{(+r.confidence).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            </>
          ) : !s.selNode ? (
            <>
              <div className="title">노드를 선택하세요</div>
              <div className="sub">KG 탐색에서 Domain Node를 고르면 매핑된 위치가 나옵니다</div>
            </>
          ) : (
            <>
              <div className="title">{s.selNode.name}</div>
              <div className="sub">문서군에 포함된 문서 중 {s.selNode.name}에 매핑된 위치</div>
              <div className="srcList">
                {listErr && <div className="empty">{listErr}</div>}
                {res && res.sources.length === 0 && <div className="empty">연결된 위치 없음</div>}
                {(res ? res.sources : []).map((src, i) => (
                  <div key={src.node_id} className={`location${selLoc === i ? " sel" : ""}`}
                    onClick={() => { setSelLoc(i); jumpTo(src.document_id, src.locator, src.node_id); }}>
                    <b>{src.document}</b>
                    <div className="sub">{src.sheet} · {(src.locator || "").split("!").pop()} ·
                      {" "}{src.rows} values · {src.mapping}
                      {src.status === "REVIEW_REQUIRED" ? " ⚠" : ""}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
        <div className="panel" style={{ display: "flex", flexDirection: "column", minHeight: 600 }}>
          <div className="sheetTabs">
            {data ? (
              <>
                {data.sheets.map((sh) => (
                  <button key={sh} className={`sheet${sh === data.sheet ? " sel" : ""}`}
                    onClick={() => { if (docId) loadSheet(docId, sh).catch((e) => setVmsg(e.message)); }}>
                    {sh}</button>
                ))}
                <span style={{ marginLeft: "auto", display: "flex", gap: 5,
                  alignItems: "center", whiteSpace: "nowrap" }}>
                  <button className={`tinyTab${s.overlayEnabled ? " active" : ""}`}
                    onClick={() => s.setOverlayEnabled(!s.overlayEnabled)}>
                    Semantic Overlay {s.overlayEnabled ? "ON" : "OFF"}</button>
                  {data.viewer && data.viewer.render_status === "SUCCESS" && docId && (
                    <a className="tinyTab" target="_blank" rel="noopener noreferrer"
                      href={`/api/viewer/documents/${encodeURIComponent(docId)}/preview?document_version=${encodeURIComponent(data.document_version || "")}`}>
                      PDF Preview</a>
                  )}
                  <span className="muted">원본 충실 렌더 · Read only</span>
                </span>
              </>
            ) : <span className="muted" style={{ padding: 6 }}>문서를 선택하세요</span>}
          </div>
          <div className="excel" style={{ flex: 1 }}>
            {data ? (
              <SheetGrid data={data} overlay={overlay} focusNode={focusNode}
                onCellClick={(nodeId) => setInspectorNode(nodeId)} />
            ) : (
              <div className="empty" style={{ padding: 16 }}>
                좌측 원본 위치를 클릭하면 원본 렌더 + Semantic Overlay가 표시됩니다</div>
            )}
          </div>
          <div className="vstatus">
            {vmsg ? vmsg : data ? (
              <>
                {data.sheet} — {data.max_row}×{data.max_col}{data.truncated ? " (잘림)" : ""} ·{" "}
                {!s.overlayEnabled ? <span className="muted">Semantic Overlay 숨김</span>
                  : allOverlay.length ? (
                    <>Overlay <span className="badge green">KEY {roles.KEY || 0}</span>{" "}
                      <span className="badge blue">VALUE {roles.VALUE || 0}</span>{" "}
                      <span className="badge amber">CONTEXT {roles.CONTEXT || 0}</span>{" "}
                      <span className="badge">미매핑 {roles.IGNORE || 0}</span></>
                  ) : <span style={{ color: "var(--amber)" }}>이 시트에는 매핑된 영역이 없습니다</span>}
                {ovErr ? <> · <span style={{ color: "var(--amber)" }}>{ovErr}</span></> : null}
                {data.viewer
                  ? <> · DRM {data.viewer.drm_status} · Render {data.viewer.render_status || "PENDING"}</>
                  : <> · Viewer source 미등록</>}
              </>
            ) : null}
          </div>
        </div>
        <aside className="panel pad insp">
          <InspectorPanel nodeId={inspectorNode}
            onAfterReview={(nodeId) => {
              if (s.reviewDoc) setReviewRefresh((k) => k + 1);
              reloadCurrent(nodeId);
            }}
            onAfterRemap={(nodeId) => reloadCurrent(nodeId)} />
        </aside>
      </div>
    </section>
  );
}
