// 1. 파일 분석 — 등록 파일 표 + 미등록(raw) 파일의 분석/DKG 제안/등록,
//    잠긴 파일(암호화/DRM)의 정식 해제 요청 흐름. web_kg loadFiles/loadRawFiles 포트.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, post } from "../lib/api";
import { useStore } from "../lib/store";
import type { FileRow, RawFile, RawSuggestion } from "../lib/types";

const FBADGE: Record<string, [string, string]> = {
  READY: ["green", "Ready"], REVIEW_REQUIRED: ["amber", "검토 필요"], ERROR: ["red", "Error"],
};

interface RawInfo { document_id: string; suggestions: RawSuggestion[]; picked: string }

type SortKey = "filename" | "author" | "created" | "template_name"
  | "headers" | "coverage_pct" | "review";
type TplFilter = "all" | "assigned" | "none";

export default function FilesScreen() {
  const s = useStore();
  const [raw, setRaw] = useState<RawFile[]>([]);
  const [rawInfo, setRawInfo] = useState<Record<string, RawInfo>>({});
  const [drmText, setDrmText] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [rowStatus, setRowStatus] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [copyLabel, setCopyLabel] = useState<Record<string, string>>({});
  const preRefs = useRef<Record<string, HTMLPreElement | null>>({});
  const [query, setQuery] = useState("");            // 파일명/작성자 검색
  const [dateFrom, setDateFrom] = useState("");      // 작성일 범위 필터
  const [dateTo, setDateTo] = useState("");
  const [tplFilter, setTplFilter] = useState<TplFilter>("all");  // 템플릿 배정 여부
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(
    { key: "filename", dir: 1 });

  const loadRawFiles = useCallback(async () => {
    try { setRaw(await api("/api/raw-files")); } catch { setRaw([]); }
  }, []);

  useEffect(() => {
    if (s.screen !== "files") return;
    s.loadFiles().catch(() => {});
    loadRawFiles().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.screen]);

  const setSt = (fn: string, msg: string) =>
    setRowStatus((m) => ({ ...m, [fn]: msg }));
  const setBusyFn = (fn: string, v: boolean) =>
    setBusy((m) => ({ ...m, [fn]: v }));

  const openDoc = (f: FileRow) => {
    s.setReviewDoc(null);
    s.show("source");
    s.requestSheet(f.document_id, null, null);
  };
  const openReview = (f: FileRow) => {
    s.setReviewDoc(f.document_id);   // §3.2 검토 큐 → 순차 검수
    s.setSelNode(null);
    s.show("source");
  };

  const analyze = async (fn: string) => {
    if (busy[fn]) return;
    setBusyFn(fn, true);
    setSt(fn, "구조 분석 중…");
    try {
      const r = await post("/api/ingest", { filename: fn, map: false });
      const sugg: RawSuggestion[] = r.suggestions || [];
      setRawInfo((m) => ({ ...m, [fn]: {
        document_id: r.document_id, suggestions: sugg,
        picked: sugg.length ? sugg[0].root_concept_id : "" } }));
      setSt(fn, "");
      setBusyFn(fn, false);
    } catch (e: any) {
      setBusyFn(fn, false);
      setSt(fn, e.message);
    }
  };

  const register = async (fn: string) => {
    const info = rawInfo[fn];
    if (busy[fn]) return;
    setBusyFn(fn, true);
    setSt(fn, "등록 중… (레시피 적용 + 자동 판정)");
    try {
      const body: Record<string, unknown> = { filename: fn };
      if (info && info.picked) body.group_id = info.picked;
      const r = await post("/api/ingest", body);
      const rc = r.recipe;
      const parts: string[] = [];
      if (r.ingest && r.ingest.unchanged !== undefined) parts.push(`승계 ${r.ingest.unchanged}`);
      if (rc) parts.push(`레시피 이식 ${rc.applied}건` +
        (rc.review ? ` (검토 ${rc.review})` : "") +
        (rc.relaxed ? " · 양식 변경 감지" : ""));
      if (r.map) parts.push(`자동 판정 ${r.map.nodes}건` +
        (r.map.REVIEW_REQUIRED ? ` (검토 ${r.map.REVIEW_REQUIRED})` : ""));
      setSt(fn, `✓ 등록 완료 — ${parts.join(" · ") || "변경 없음"}`);
      setRawInfo((m) => { const n = { ...m }; delete n[fn]; return n; });
      setBusyFn(fn, false);
      await s.reloadKg();          // 파일 표의 DKG 배지가 최신 그룹으로 그려지도록
      await s.loadFiles();         // dkgs 갱신 이후에 렌더 (순서 중요)
      setTimeout(() => loadRawFiles().catch(() => {}), 2500);  // 토스트 읽을 시간
    } catch (e: any) {
      setBusyFn(fn, false);
      setSt(fn, `실패: ${e.message}`);
    }
  };

  const drmRequest = async (fn: string, note: string, reissue: boolean) => {
    try {
      const r = await post("/api/drm/request", { filename: fn, note });
      setDrmText((m) => ({ ...m, [fn]: r.request_text }));
      await loadRawFiles();
    } catch (e: any) {
      setSt(fn, reissue ? `재발급 실패: ${e.message}` : e.message);
    }
  };

  const copyText = async (fn: string) => {
    try {
      await navigator.clipboard.writeText(drmText[fn] || "");
      setCopyLabel((m) => ({ ...m, [fn]: "✓ 복사됨" }));
    } catch {
      const pre = preRefs.current[fn];
      if (pre) {
        const r = document.createRange();
        r.selectNodeContents(pre);
        const sel = getSelection();
        if (sel) { sel.removeAllRanges(); sel.addRange(r); }
      }
      setCopyLabel((m) => ({ ...m, [fn]: "선택됨 — Ctrl+C" }));
    }
  };

  // 검색(파일명/작성자/템플릿) → 작성일 범위 → 템플릿 배정 여부 필터 → 정렬
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    let rows = s.files.filter((f) =>
      !q || f.filename.toLowerCase().includes(q) ||
      (f.author || "").toLowerCase().includes(q) ||
      (f.templates || []).some((t) => t.name.toLowerCase().includes(q)));
    if (dateFrom) rows = rows.filter((f) => (f.created || "").slice(0, 10) >= dateFrom);
    if (dateTo) rows = rows.filter((f) => (f.created || "").slice(0, 10) <= dateTo);
    if (tplFilter !== "all")
      rows = rows.filter((f) => (tplFilter === "assigned") === !!(f.templates || []).length);
    return [...rows].sort((a, b) => {
      const va = a[sort.key] ?? "", vb = b[sort.key] ?? "";
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb : String(va).localeCompare(String(vb), "ko");
      return cmp * sort.dir;
    });
  }, [s.files, query, dateFrom, dateTo, tplFilter, sort]);

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th style={{ cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" }}
      title="클릭해서 정렬"
      onClick={() => setSort((p) =>
        ({ key: k, dir: p.key === k ? (-p.dir as 1 | -1) : 1 }))}>
      {children}{sort.key === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  // '분석'으로 구조만 적재된 파일은 서버 목록에서 빠지므로 rawInfo 쪽을 합친다
  const names = [...new Set([...raw.map((f) => f.filename), ...Object.keys(rawInfo)])].sort();
  const byName = Object.fromEntries(raw.map((f) => [f.filename, f]));

  const rawRow = (fn: string) => {
    const f = byName[fn] || ({} as RawFile);
    const info = rawInfo[fn];
    let badge: React.ReactNode = null;
    let inner: React.ReactNode;
    if (f.locked) {
      const drm = f.drm;
      if (drm && drm.status === "REQUESTED") {
        badge = <span className="badge amber"> 해제 요청됨 · {(drm.requested_at || "").slice(0, 10)}</span>;
        inner = (
          <>
            <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>
              {f.container_detail || ""} — 해제본이 data/raw에 같은 파일명으로 도착하면
              자동 감지되어 등록 가능해집니다.</div>
            <button className="secondary" style={{ marginTop: 6 }}
              onClick={() => drmRequest(fn, drm.note || "", true)}>요청서 재발급·복사</button>
          </>
        );
      } else {
        badge = <span className="badge red"> 🔒 잠김 (암호화/DRM)</span>;
        inner = (
          <>
            <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>
              {f.container_detail || ""} — 파싱·뷰어 모두 불가. 정식 해제 요청서를 만들어
              결재/그룹웨어에 첨부하세요.</div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }} className="editForm">
              <input placeholder="요청 사유 (선택)" style={{ flex: 1, marginTop: 0 }}
                value={notes[fn] || ""}
                onChange={(e) => setNotes((m) => ({ ...m, [fn]: e.target.value }))} />
              <button className="primary"
                onClick={() => drmRequest(fn, (notes[fn] || "").trim(), false)}>정식 해제 요청</button>
            </div>
          </>
        );
      }
    } else if (info) {
      const pick = (g: string) =>
        setRawInfo((m) => ({ ...m, [fn]: { ...m[fn], picked: g } }));
      inner = (
        <>
          <div style={{ marginTop: 6, fontSize: 12 }}>
            {(info.suggestions || []).length
              ? "같은 양식으로 보이는 문서군 — 선택하면 레시피로 매핑을 이식합니다:"
              : "비슷한 양식의 문서군이 없습니다."}
            <br />
            {(info.suggestions || []).map((sg) => (
              <span key={sg.root_concept_id}
                className={`chip pick${info.picked === sg.root_concept_id ? " sel" : ""}`}
                onClick={() => pick(sg.root_concept_id)}>
                {sg.name} · {sg.match_pct}%{sg.has_recipe ? " · 레시피" : ""}</span>
            ))}
            <span className={`chip pick${info.picked === "" ? " sel" : ""}`}
              onClick={() => pick("")}>새 형식 (자동 판정)</span>
          </div>
          <button className="primary" style={{ marginTop: 7 }} disabled={!!busy[fn]}
            onClick={() => register(fn)}>
            {info.picked ? "선택한 문서군으로 등록" : "등록 (자동 판정)"}</button>
        </>
      );
    } else {
      if (f.drm && f.drm.status === "RELEASED")
        badge = <span className="badge green"> ✓ 해제본 도착 — 등록 가능</span>;
      inner = (
        <div><button className="secondary" style={{ marginTop: 5 }} disabled={!!busy[fn]}
          onClick={() => analyze(fn)}>분석 · DKG 제안</button></div>
      );
    }
    return (
      <div className="fileRow" style={{ cursor: "default" }} key={fn}>
        <b>{fn}</b>{badge}{inner}
        {drmText[fn] && (
          <>
            <pre ref={(el) => { preRefs.current[fn] = el; }}
              style={{ marginTop: 7, padding: 9, border: "1px solid var(--line)",
                borderRadius: 8, fontSize: 11, whiteSpace: "pre-wrap", background: "#fff" }}>
              {drmText[fn]}</pre>
            <button className="secondary" onClick={() => copyText(fn)}>
              {copyLabel[fn] || "요청서 복사"}</button>{" "}
            <button className="secondary" onClick={() => {
              setDrmText((m) => { const n = { ...m }; delete n[fn]; return n; });
              setCopyLabel((m) => { const n = { ...m }; delete n[fn]; return n; });
            }}>닫기</button>
          </>
        )}
        <div className="status">{rowStatus[fn] || ""}</div>
      </div>
    );
  };

  return (
    <section className={`screen${s.screen === "files" ? " active" : ""}`}>
      {names.length > 0 && (
        <div className="panel pad" style={{ marginBottom: 14 }}>
          <div className="kicker">미등록 파일</div>
          <div className="sub">data/raw에 새 파일이 있습니다 — 분석하면 같은 양식의 문서군을
            제안하고, 배정하면 저장된 추출 레시피로 매핑을 이식합니다.</div>
          <div style={{ marginTop: 8 }}>{names.map(rawRow)}</div>
        </div>
      )}
      <div className="panel pad">
        <div className="title">파일 분석</div>
        <div className="sub">등록된 Excel의 분석 상태와 개념 / 문서군 매핑 현황입니다.
          파일은 data/raw에 두면 위 미등록 목록에 나타납니다.</div>
        <div className="editForm"
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 12 }}>
          <input placeholder="파일명 / 작성자 / 템플릿 검색" value={query}
            style={{ flex: "1 1 220px", marginTop: 0 }}
            onChange={(e) => setQuery(e.target.value)} />
          <label style={{ fontSize: 11, color: "var(--muted)", marginTop: 0 }}>작성일</label>
          <input type="date" value={dateFrom} style={{ width: 150, marginTop: 0 }}
            onChange={(e) => setDateFrom(e.target.value)} />
          <span className="muted">~</span>
          <input type="date" value={dateTo} style={{ width: 150, marginTop: 0 }}
            onChange={(e) => setDateTo(e.target.value)} />
          <span style={{ display: "inline-flex", gap: 4 }}>
            {([["all", "전체"], ["assigned", "템플릿 배정"], ["none", "미배정"]] as
              [TplFilter, string][]).map(([k, label]) => (
              <span key={k} className={`chip pick${tplFilter === k ? " sel" : ""}`}
                onClick={() => setTplFilter(k)}>{label}</span>
            ))}
          </span>
          {(query || dateFrom || dateTo || tplFilter !== "all") && (
            <button className="secondary"
              onClick={() => { setQuery(""); setDateFrom(""); setDateTo(""); setTplFilter("all"); }}>
              초기화</button>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            {visibleFiles.length} / {s.files.length}건</span>
        </div>
        <table className="table" style={{ marginTop: 10 }}>
          <thead><tr>
            <Th k="filename">파일</Th><Th k="author">작성자</Th><Th k="created">작성일</Th>
            <th>문서군</th><Th k="template_name">템플릿</Th>
            <Th k="headers">매핑 노드</Th><Th k="coverage_pct">개념 매핑</Th>
            <Th k="review">검토</Th><th>DRM / Viewer</th><th>상태</th><th></th></tr></thead>
          <tbody>
            {visibleFiles.length ? visibleFiles.map((f) => {
              const [cls, label] = FBADGE[f.status] || ["", f.status];
              const memberOf = s.dkgs.filter((g) =>
                (g.member_document_ids || []).includes(f.document_id));
              return (
                <tr key={f.document_id}>
                  <td><b>{f.filename}</b></td>
                  <td>{f.author || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}
                    title={f.created || ""}>{(f.created || "").slice(0, 10) || "—"}</td>
                  <td>{memberOf.length ? memberOf.map((g) => (
                    <span key={g.id} className="badge"
                      style={{ borderColor: s.dkgColor(g.id), color: s.dkgColor(g.id) }}>
                      {g.name}</span>
                  )) : "—"}</td>
                  <td>{(f.templates || []).length ? (f.templates || []).map((t) => (
                    <span key={t.template_id} className="badge blue"
                      title={`파싱 템플릿 — ${t.status}`}
                      style={{ marginRight: 4 }}>
                      {t.name} v{t.version}</span>
                  )) : (
                    <span className="badge" style={{ color: "var(--muted)" }}>미배정</span>
                  )}</td>
                  <td>{f.headers}</td>
                  <td>{f.coverage_pct}%</td>
                  <td>{f.review ? (
                    <button className="secondary" onClick={() => openReview(f)}>
                      {f.review}건 검수</button>) : "—"}</td>
                  <td>
                    <span className={`badge ${f.drm_status === "READY" ? "green" : "amber"}`}>
                      {f.drm_status || "PROTECTED"}</span>{" "}
                    {f.render_status && (
                      <span className={`badge ${f.render_status === "SUCCESS" ? "green"
                        : (f.render_status === "FAILED" ? "red" : "")}`}>
                        Render {f.render_status}</span>
                    )}{" "}
                    {f.parsing_status && <span className="badge blue">Parse {f.parsing_status}</span>}
                  </td>
                  <td><span className={`badge ${cls}`}>{label}</span></td>
                  <td><button className="secondary" onClick={() => openDoc(f)}>열어보기</button></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={11} className="empty">
                {s.files.length
                  ? "검색/필터 조건에 맞는 파일이 없습니다"
                  : "등록된 파일이 없습니다 — kg ingest를 먼저 실행하세요"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
