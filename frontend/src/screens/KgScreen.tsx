// 2. KG 탐색 — 좌측 내비(전체 KG/문서군), 중앙 그래프(Domain/문서군),
//    우측 상세(노드/DKG/개념 편집기). web_kg의 KG 탐색 화면 포트.
import { useEffect, useRef, useState } from "react";
import { api, post } from "../lib/api";
import { useStore } from "../lib/store";
import type { DkgDetailData, RecrawlRun } from "../lib/types";
import DomainGraph from "./kg/DomainGraph";
import DocGraph from "./kg/DocGraph";
import DkgDetailPanel from "./kg/DkgDetailPanel";
import ConceptEditor from "./kg/ConceptEditor";

type Detail = { kind: "node" } | { kind: "dkg" } | { kind: "editor"; cid: string | null };

function NodeDetailPanel({ onOpenDocKg, onOpenSource, onEdit }: {
  onOpenDocKg: () => void; onOpenSource: () => void; onEdit: (cid: string) => void;
}) {
  const s = useStore();
  const [status, setStatus] = useState("");
  const n = s.selNode!;
  useEffect(() => { setStatus(""); }, [n.id]);
  const res = s.nodeSearch && s.nodeSearch.concept.concept_id === n.id ? s.nodeSearch : null;
  const g = n.root ? s.dkgOf(n.root) : undefined;
  const inCart = s.cartItems().some((x) => x.concept_id === n.id);
  return (
    <>
      <div className="kicker">SELECTED DOMAIN NODE</div>
      <div className="title">{n.name}</div>
      <div className="sub">{(res && res.concept.description) || ""}</div>
      {inCart && <span className="badge blue" style={{ marginTop: 8 }}>✓ 통합 대상 포함됨</span>}
      <div className="metricGrid">
        <div className="metric"><span>문서군</span><b>{g ? 1 : 0}</b></div>
        <div className="metric"><span>소속 문서</span><b>{res ? res.documents.length : 0}</b></div>
        <div className="metric"><span>데이터 위치</span><b>{res ? res.sources.length : 0}</b></div>
        <div className="metric"><span>값</span><b>{res ? res.total_rows : 0}</b></div>
      </div>
      {g && (
        <>
          <div style={{ marginTop: 14 }} className="kicker">CONNECTED DOCUMENT GROUP</div>
          <div className="dkgCard" onClick={onOpenDocKg}>
            <b style={{ color: s.dkgColor(g.id) }}>{g.name}</b>
            <div>개념 {g.domain_node_ids.length} · 문서 {g.member_document_count} —{" "}
              {g.domain_node_ids.slice(0, 4).map((i) =>
                (s.domain?.nodes.find((x) => x.id === i) || { name: i }).name).join(" / ")}
              {g.domain_node_ids.length > 4 ? ` 외 ${g.domain_node_ids.length - 4}개` : ""}</div>
          </div>
        </>
      )}
      <div className="rightBtns">
        <button className="primary" onClick={onOpenDocKg}>문서군 상세 보기</button>
        <button className="secondary" onClick={onOpenSource}>이 노드의 원본 데이터 보기</button>
        <button className="secondary" onClick={() => {
          if (!res) return;
          s.addCart(res.sources.filter((x) => x.status !== "REVIEW_REQUIRED").map((x) => ({
            node_id: x.node_id, concept_id: n.id, header: x.header,
            document: x.document, sheet: x.sheet,
            range: (x.locator || "").split("!").pop() || "", role: null })));
          setStatus(`✓ ${res.sources.length}개 위치를 통합 대상에 담았습니다.`);
        }}>통합 DB 대상에 추가</button>
        <button className="secondary" onClick={() => onEdit(n.id)}>개념 편집</button>
      </div>
      <div className="status">{status}</div>
    </>
  );
}

export default function KgScreen() {
  const s = useStore();
  const [navTab, setNavTab] = useState<"domain" | "doc">("domain");
  const [searchInput, setSearchInput] = useState("");
  const [filter, setFilter] = useState("");
  const [docMode, setDocMode] = useState(false);
  const [zoom, setZoom] = useState(1);          // 그래프 확대/축소 (0.5×~2.5×)
  const [detail, setDetail] = useState<Detail | null>(null);
  const [dkgDetail, setDkgDetail] = useState<DkgDetailData | null>(null);
  const [dkgFail, setDkgFail] = useState<string | null>(null);
  const dkgSeq = useRef(0);
  const [recrawlRuns, setRecrawlRuns] = useState<Record<string, RecrawlRun | null>>({});
  const [recrawlBusy, setRecrawlBusy] = useState<Record<string, boolean>>({});
  const timers = useRef<number[]>([]);
  const debounceT = useRef<number | undefined>(undefined);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  // DKG 상세 조회 — 선택/데이터 변경(kgVersion) 시 재조회, 연타 경쟁 가드
  useEffect(() => {
    if (!s.selDkg) { setDkgDetail(null); setDkgFail(null); return; }
    const cur = s.selDkg;
    const seq = ++dkgSeq.current;
    api(`/api/kg/document/${encodeURIComponent(cur)}`)
      .then((d) => { if (seq === dkgSeq.current) { setDkgDetail(d); setDkgFail(null); } })
      .catch(() => { if (seq === dkgSeq.current) { setDkgDetail(null); setDkgFail(cur); } });
  }, [s.selDkg, s.kgVersion]);

  const selectNode = async (nodeId: string) => {
    const n = s.domain?.nodes.find((x) => x.id === nodeId);
    if (!n) return;
    s.setSelNode({ id: n.id, name: n.name, root: n.root });
    s.setSelDkg(n.root);
    setDocMode(false);
    setDetail({ kind: "node" });
    try { s.setNodeSearch(await api(`/api/search?concept=${encodeURIComponent(n.id)}`)); }
    catch { s.setNodeSearch(null); }
  };

  const selectDkg = (dkgId: string, toDocGraph = false) => {
    if (s.selDkg !== dkgId) s.setSelDkgDoc(null);
    s.setSelDkg(dkgId);
    setDetail({ kind: "dkg" });
    if (toDocGraph) setDocMode(true);
  };

  const pollRecrawl = (gid: string, runId: string) => {
    let fails = 0;
    const tick = () => api(`/api/recrawl/${encodeURIComponent(runId)}`)
      .then((r: RecrawlRun) => {
        fails = 0;
        setRecrawlRuns((m) => ({ ...m, [gid]: r }));
        if (r.status === "RUNNING") timers.current.push(window.setTimeout(tick, 2000));
        else {
          setRecrawlBusy((m) => ({ ...m, [gid]: false }));
          s.loadFiles().catch(() => {});
          s.reloadKg().catch(() => {});
        }
      })
      .catch(() => {
        // 일시 오류로 체인이 조용히 끊기지 않게 — 연속 5회 실패 시 중단 통보
        if (++fails <= 5) timers.current.push(window.setTimeout(tick, 3000));
        else {
          setRecrawlRuns((m) => ({ ...m, [gid]: { status: "POLL_LOST", summary: [] } }));
          setRecrawlBusy((m) => ({ ...m, [gid]: false }));
        }
      });
    tick();
  };

  const startRecrawl = async (gid: string, mode: string) => {
    setRecrawlBusy((m) => ({ ...m, [gid]: true }));
    try {
      const r = await post(`/api/group/${encodeURIComponent(gid)}/recrawl`, { mode });
      pollRecrawl(gid, r.run_id);
    } catch (e) {
      setRecrawlBusy((m) => ({ ...m, [gid]: false }));
      throw e;
    }
  };

  const g = s.selDkg ? s.dkgOf(s.selDkg) : undefined;
  const leafs = (s.domain?.nodes || []).filter((n) => n.level !== "L1")
    .filter((n) => !filter || n.name.includes(filter) || n.id.includes(filter))
    .sort((a, b) => b.sources - a.sources);
  const dkgList = s.dkgs.filter((x) => !filter || x.name.includes(filter));

  const openDocGraphTab = () => {
    if (!s.selDkg && s.dkgs.length) selectDkg(s.dkgs[0].id, true);
    else { setDocMode(true); setDetail({ kind: "dkg" }); }
  };

  const rightPanel = () => {
    if (detail?.kind === "editor")
      return <ConceptEditor cid={detail.cid}
        onCreated={(id) => selectNode(id)} onBack={(cid) => selectNode(cid)} />;
    if (detail?.kind === "dkg" && s.selDkg) {
      if (dkgFail === s.selDkg)
        return <div className="empty">문서군 상세를 불러오지 못했습니다</div>;
      if (!dkgDetail || dkgDetail.id !== s.selDkg)
        return <div className="empty">불러오는 중…</div>;
      return <DkgDetailPanel g={dkgDetail}
        recrawlRun={recrawlRuns[s.selDkg] || null}
        recrawlBusy={!!recrawlBusy[s.selDkg]}
        onStartRecrawl={(mode) => { startRecrawl(s.selDkg!, mode).catch(() => {}); }}
        onOpenDocument={(documentId) => {
          s.setSelDkgDoc(documentId);
          s.setReviewDoc(null);
          s.show("source");
          s.requestSheet(documentId, null, null);
        }}
        onBackDomain={() => { s.setSelDkg(null); setDocMode(false); setDetail(null); }} />;
    }
    if (detail?.kind === "node" && s.selNode)
      return <NodeDetailPanel
        onOpenDocKg={() => {
          if (s.selNode?.root) selectDkg(s.selNode.root, true);
        }}
        onOpenSource={() => { s.setReviewDoc(null); s.show("source"); }}
        onEdit={(cid) => setDetail({ kind: "editor", cid })} />;
    return <div className="empty">Domain Node 또는 문서군 영역을 클릭하세요</div>;
  };

  return (
    <section className={`screen${s.screen === "kg" ? " active" : ""}`}>
      <div className="grid3">
        <aside className="panel pad">
          <div className="kicker">CONCEPT NAVIGATION</div>
          <div className="title">개념 탐색</div>
          <input className="search" placeholder="노드 / 문서군 검색" value={searchInput}
            onChange={(e) => {
              const v = e.target.value;
              setSearchInput(v);
              clearTimeout(debounceT.current);
              debounceT.current = window.setTimeout(() => setFilter(v.trim()), 200);
            }} />
          <div className="tabs">
            <button className={`tinyTab${navTab === "domain" ? " active" : ""}`}
              onClick={() => setNavTab("domain")}>전체 개념</button>
            <button className={`tinyTab${navTab === "doc" ? " active" : ""}`}
              onClick={() => setNavTab("doc")}>문서군</button>
          </div>
          {navTab === "domain" ? (
            <div style={{ marginTop: 9, maxHeight: "46vh", overflowY: "auto" }}>
              {leafs.map((n) => (
                <button key={n.id}
                  className={`listBtn${s.selNode && s.selNode.id === n.id ? " sel" : ""}`}
                  onClick={() => selectNode(n.id)}>
                  <span>{n.name}</span><span className="n">{n.sources}</span>
                </button>
              ))}
            </div>
          ) : (
            <div style={{ marginTop: 9, maxHeight: "46vh", overflowY: "auto" }}>
              {dkgList.map((x) => (
                <div key={x.id} className={`dkgCard${s.selDkg === x.id ? " sel" : ""}`}
                  onClick={() => selectDkg(x.id, true)}>
                  <b style={{ color: s.dkgColor(x.id) }}>{x.name}</b>
                  <div>개념 {x.domain_node_ids.length} · 문서 {x.member_document_count} ·
                    {" "}위치 {x.source_location_count}</div>
                </div>
              ))}
            </div>
          )}
          <button className="secondary w100" style={{ marginTop: 9 }}
            onClick={() => setDetail({ kind: "editor", cid: null })}>
            + 새 개념 <span className="muted" style={{ fontSize: 10 }}>(L1이면 새 문서군)</span>
          </button>
          <div style={{ display: "grid", gap: 7, fontSize: 12, marginTop: 12 }}>
            {s.dkgs.map((x) => (
              <div key={x.id}>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: "50%",
                  background: s.dkgColor(x.id), marginRight: 7 }} />
                {x.name} · {x.member_document_count} docs
              </div>
            ))}
          </div>
        </aside>
        <div className="panel">
          <div className="graphHead">
            <div>
              <div className="crumb">
                {docMode && g
                  ? <><b>전체 개념</b> › {g.name}</>
                  : <><b>전체 개념</b> · 문서군 Coverage</>}
              </div>
              <div className="title">
                {docMode ? "문서군에 어떤 문서가 속하는지 보기" : "전체 개념에서 문서군 위치 보기"}
              </div>
              <div className="sub">
                {docMode
                  ? "선택한 문서군의 Domain Node와 그 노드에 데이터를 제공하는 문서를 함께 봅니다."
                  : "반투명 영역은 각 문서군이 전체 개념의 어느 노드들을 커버하는지 나타냅니다."}
              </div>
            </div>
            <div className="tabs" style={{ alignItems: "center" }}>
              <button className={`tinyTab${!docMode ? " active" : ""}`}
                onClick={() => setDocMode(false)}>전체 개념</button>
              <button className={`tinyTab${docMode ? " active" : ""}`}
                onClick={openDocGraphTab}>문서군 상세</button>
              <span style={{ display: "inline-flex", gap: 4, marginLeft: 8, alignItems: "center" }}>
                <button className="tinyTab" title="축소" aria-label="그래프 축소"
                  onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 4) / 4))}>−</button>
                <button className="tinyTab" title="원래 크기로"
                  onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                <button className="tinyTab" title="확대" aria-label="그래프 확대"
                  onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.25) * 4) / 4))}>＋</button>
              </span>
            </div>
          </div>
          {!docMode ? (
            <div className="graphWrap" style={{ overflow: "auto", maxHeight: 680 }}>
              {s.domain && <DomainGraph domain={s.domain} dkgs={s.dkgs} zoom={zoom}
                selDkg={s.selDkg} selNode={s.selNode} dkgColor={s.dkgColor}
                onSelectNode={selectNode} onSelectDkg={(id) => selectDkg(id)} />}
            </div>
          ) : (
            <div className="graphWrap" style={{ overflow: "auto", maxHeight: 680 }}>
              {s.domain && dkgDetail && dkgDetail.id === s.selDkg ? (
                <DocGraph g={dkgDetail} domain={s.domain} color={s.dkgColor(dkgDetail.id)}
                  zoom={zoom} selDkgDoc={s.selDkgDoc}
                  onSelectDoc={(id) => { s.setSelDkgDoc(id); setDetail({ kind: "dkg" }); }} />
              ) : <div className="empty">불러오는 중…</div>}
            </div>
          )}
        </div>
        <aside className="panel pad">{rightPanel()}</aside>
      </div>
    </section>
  );
}
