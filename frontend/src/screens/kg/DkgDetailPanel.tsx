// 문서군 상세 패널 — 멤버 델타(포함/제외), PARSING TEMPLATES, 추출 레시피
// (스냅샷/이력/롤백), 재크롤링. web_kg renderDkgDetail 포트.
import { useState } from "react";
import { api, post } from "../../lib/api";
import { useStore } from "../../lib/store";
import type { DkgDetailData, RecrawlDocSummary, RecrawlRun } from "../../lib/types";
import { templateGroups } from "./templateGroups";

interface HistRow { recipe_id: string; status: string; created_at?: string; note?: string }

interface Props {
  g: DkgDetailData;
  recrawlRun: RecrawlRun | null;
  recrawlBusy: boolean;
  openTpl: string | null;                       // 문서 목록이 열린 템플릿 (그래프와 공유)
  onToggleTpl: (label: string | null) => void;
  onStartRecrawl: (mode: string) => void;
  onOpenDocument: (documentId: string) => void;
  onBackDomain: () => void;
}

function RecrawlBadges({ d }: { d: RecrawlDocSummary }) {
  if (d.error) return <span className="badge red">오류</span>;
  if (d.map === null || d.map === undefined) return <span className="badge">진행 중</span>;
  const review = (d.map ? d.map.REVIEW_REQUIRED || 0 : 0) + (d.recipe ? d.recipe.review || 0 : 0);
  return (
    <>
      {d.ingest && d.ingest.skipped !== undefined
        ? <span className="badge">승계</span> : <span className="badge blue">재적재</span>}{" "}
      {d.recipe && d.recipe.applied
        ? <span className="badge blue">레시피 {d.recipe.applied}</span> : null}{" "}
      {review ? <span className="badge amber">검토 {review}</span> : null}{" "}
      {d.recipe && d.recipe.relaxed ? <span className="badge amber">양식 변경 감지</span> : null}
    </>
  );
}

export default function DkgDetailPanel({ g, recrawlRun, recrawlBusy,
  openTpl, onToggleTpl, onStartRecrawl, onOpenDocument, onBackDomain }: Props) {
  const s = useStore();
  const [status, setStatus] = useState("");
  const [hist, setHist] = useState<HistRow[] | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [mode, setMode] = useState("fill");

  const color = s.dkgColor(g.id);
  const rec = g.recipe;
  const memberIds = new Set((g.member_documents || []).map((d) => d.document_id));
  const addable = s.files.filter((f) => !memberIds.has(f.document_id));

  // 멤버/레시피 변경 후 공통 갱신 — reloadKg가 kgVersion을 올려 상세 재조회를 유발
  const refreshDkg = () => s.reloadKg();

  const member = async (documentId: string, state: "INCLUDED" | "EXCLUDED") => {
    try {
      await post(`/api/group/${encodeURIComponent(g.id)}/member`,
        { document_id: documentId, state });
      await refreshDkg();
    } catch (e: any) { setStatus(e.message); }
  };

  const snapshot = async () => {
    setSnapBusy(true);
    try {
      const r = await post(`/api/group/${encodeURIComponent(g.id)}/recipe`, {});
      setStatus(`✓ 레시피 저장 — 템플릿 ${r.template}건, 충돌 ${r.conflicts}, 동률 제외 ${r.dropped}`);
      await refreshDkg();
    } catch (e: any) { setStatus(e.message); }
    setSnapBusy(false);
  };

  const loadHistory = async () => {
    try {
      const r = await api(`/api/group/${encodeURIComponent(g.id)}/recipe`);
      setHist(r.history);
    } catch (e: any) { setHist([]); setStatus(e.message); }
  };

  const rollback = async (recipeId: string) => {
    try {
      await post(`/api/group/${encodeURIComponent(g.id)}/recipe/${recipeId}/rollback`, {});
      setStatus("✓ 롤백 — 해당 버전을 복사한 새 활성 레시피를 만들었습니다.");
      setHist(null);
      await refreshDkg();
    } catch (e: any) { setStatus(e.message); }
  };

  const doneReview = recrawlRun && recrawlRun.status !== "RUNNING" &&
    recrawlRun.status !== "POLL_LOST"
    ? recrawlRun.summary.reduce((a, d) =>
        a + (d.map ? d.map.REVIEW_REQUIRED || 0 : 0) + (d.recipe ? d.recipe.review || 0 : 0), 0)
    : 0;

  return (
    <>
      <div className="kicker">SELECTED DOCUMENT GROUP</div>
      <div className="title" style={{ color }}>{g.name}</div>
      <div className="sub">문서군[개념] → 템플릿(파싱 스크립트 기준 분류) → 문서</div>
      <div className="metricGrid">
        <div className="metric"><span>개념</span><b>{g.domain_node_ids.length}</b></div>
        <div className="metric"><span>문서</span><b>{g.member_document_count}</b></div>
        <div className="metric"><span>Source 위치</span><b>{g.source_location_count}</b></div>
        <div className="metric"><span>값</span><b>{g.value_count.toLocaleString()}</b></div>
      </div>

      {/* 계층은 템플릿까지만 펼쳐 보인다 — 문서 목록은 '문서 N개'를 눌러야
          표로 열린다 (문서군 → 템플릿 → 문서 개수). */}
      <div style={{ marginTop: 13 }} className="kicker">템플릿 (파싱 스크립트 기준 분류)</div>
      {(() => {
        const members = g.member_documents || [];
        const groups = templateGroups(g);
        const docTable = (docs: typeof members) => (
          <div style={{ marginTop: 6, border: "1px solid var(--line)",
            borderRadius: 8, maxHeight: "26vh", overflowY: "auto" }}>
            <table className="table">
              <thead><tr><th>문서</th>
                <th style={{ whiteSpace: "nowrap" }}>개념</th>
                <th style={{ whiteSpace: "nowrap" }}>위치</th><th></th></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.document_id}
                    style={{ cursor: "pointer",
                      background: s.selDkgDoc === d.document_id ? "var(--blue2)" : undefined }}
                    title="클릭하면 원본 데이터로 이동합니다"
                    onClick={() => onOpenDocument(d.document_id)}>
                    <td><b>{d.filename}</b>
                      {d.override === "INCLUDED" && <span className="badge blue"> 고정</span>}</td>
                    <td title={d.nodes.join(", ")}>{d.nodes.length}개</td>
                    <td>{d.sources}</td>
                    <td><button title="이 그룹에서 제외 (매핑/빌드 소스는 유지)"
                      style={{ border: 0, background: "none", color: "var(--red)",
                        cursor: "pointer" }}
                      onClick={(ev) => { ev.stopPropagation(); member(d.document_id, "EXCLUDED"); }}>
                      제외</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        return groups.map((grp) => {
          const isEtc = grp.isEtc;
          if (isEtc && !grp.docs.length) return null;   // 미배정이 없으면 숨김
          const open = openTpl === grp.label;
          return (
            <div key={grp.label} className="dkgCard" style={{ cursor: "default",
              borderLeft: `4px solid ${isEtc ? "var(--line)" : "var(--purple)"}` }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b style={{ color: isEtc ? "var(--muted)" : "var(--purple)" }}>▣ {grp.label}</b>
                {grp.review ? <span className="badge amber">검토 {grp.review}</span> : null}
                <button className="secondary"
                  style={{ marginLeft: "auto", padding: "4px 9px", fontSize: 12 }}
                  onClick={() => onToggleTpl(open ? null : grp.label)}>
                  문서 {grp.docs.length}개 {open ? "▴" : "▾"}</button>
              </div>
              {open && (grp.docs.length ? docTable(grp.docs)
                : <div className="empty">소속 문서가 없습니다</div>)}
            </div>
          );
        });
      })()}
      <div className="sub" style={{ fontSize: 11 }}>
        문서 개수를 누르면 문서 목록이 열리고, 문서를 누르면 원본 데이터로
        이동합니다.</div>
      {addable.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 7 }} className="editForm">
          <select style={{ flex: 1, marginTop: 0 }} value=""
            onChange={(e) => { if (e.target.value) member(e.target.value, "INCLUDED"); }}>
            <option value="">문서 추가 (그룹에 고정)…</option>
            {addable.map((f) => (
              <option key={f.document_id} value={f.document_id}>{f.filename}</option>
            ))}
          </select>
        </div>
      )}
      <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>
        제외/추가는 그룹 소속만 바꿉니다 — 매핑과 빌드 소스는 유지됩니다.</div>

      <div style={{ marginTop: 13 }} className="kicker">EXTRACTION RECIPE</div>
      {rec ? (
        <div style={{ fontSize: 12 }}>템플릿 {rec.template}건
          {rec.conflicts ? <> · <span style={{ color: "var(--amber)" }}>충돌 {rec.conflicts}</span></> : null}
          {rec.dropped ? <> · 동률 제외 {rec.dropped}</> : null}
          {rec.stale_entries ? <> · <span style={{ color: "var(--red)" }}>소멸 개념 {rec.stale_entries}</span></> : null}
          <div className="sub" style={{ fontSize: 11 }}>{rec.recipe_id} · {rec.created_at.slice(0, 16)}</div>
        </div>
      ) : (
        <div className="sub" style={{ fontSize: 12 }}>
          저장된 레시피가 없습니다 — 승인된 매핑에서 스냅샷을 만들면 같은 형식의 새 문서에
          매핑이 이식됩니다.</div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 7, flexWrap: "wrap" }}>
        <button className="secondary" disabled={snapBusy} onClick={snapshot}>
          {rec ? "레시피 재저장" : "레시피 저장"}</button>
        {rec && <button className="secondary" onClick={loadHistory}>이력</button>}
      </div>
      {hist && (
        <div>
          {hist.map((h) => (
            <div className="progRow" key={h.recipe_id}>
              <span>{h.recipe_id} · {h.status} · {(h.created_at || "").slice(0, 16)}
                {h.note ? ` · ${h.note.slice(0, 30)}` : ""}</span>
              {h.status === "ARCHIVED" ? (
                <button style={{ border: 0, background: "none", color: "var(--blue)", cursor: "pointer" }}
                  onClick={() => rollback(h.recipe_id)}>이 버전으로</button>
              ) : <span className="badge green">활성</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 13 }} className="kicker">RECRAWL</div>
      <div className="editForm" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select style={{ flex: 1, marginTop: 0 }} value={mode}
          onChange={(e) => setMode(e.target.value)}>
          <option value="fill">증분 (fill) — 미매핑만 재평가</option>
          <option value="reset_auto">자동매핑 초기화 (reset_auto)</option>
        </select>
        <button className="primary" disabled={recrawlBusy}
          onClick={() => onStartRecrawl(mode)}>재크롤링</button>
      </div>
      <div className="sub" style={{ fontSize: 11, marginTop: 4 }}>
        사람 승인/거절은 보존됩니다. reset_auto는 검수 대기 항목도 재판정합니다.</div>
      {g.last_recrawl && (
        <div className="sub" style={{ fontSize: 11 }}>최근:{" "}
          {g.last_recrawl.mode} · {g.last_recrawl.status} ·{" "}
          {(g.last_recrawl.started_at || "").slice(0, 16)}</div>
      )}
      <div>
        {recrawlRun && recrawlRun.status === "POLL_LOST" && (
          <div className="empty">진행 조회가 끊겼습니다 — 서버는 계속 실행 중일 수 있습니다.
            DKG를 다시 선택해 상태를 확인하세요.</div>
        )}
        {recrawlRun && recrawlRun.status !== "POLL_LOST" && (
          <>
            <div className="sub" style={{ marginTop: 6 }}>
              {recrawlRun.status} · {recrawlRun.summary.length}건</div>
            {recrawlRun.summary.map((d) => (
              <div className="progRow" key={d.filename}>
                <span>{d.filename}
                  {d.error ? <> — <span style={{ color: "var(--red)" }}>{d.error}</span></> : null}</span>
                <span><RecrawlBadges d={d} /></span>
              </div>
            ))}
            {recrawlRun.status !== "RUNNING" && (
              <div className="status">✓ 완료 ({recrawlRun.status})
                {doneReview ? ` — 검토 필요 ${doneReview}건은 파일 탭에서 검수하세요` : ""}</div>
            )}
          </>
        )}
      </div>

      <div className="rightBtns">
        <button className="secondary" onClick={onBackDomain}>전체 개념으로 돌아가기</button>
      </div>
      <div className="status">{status}</div>
    </>
  );
}
