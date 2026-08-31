// 문서군 상세 패널 — 멤버 델타(포함/제외), PARSING TEMPLATES, 추출 레시피
// (스냅샷/이력/롤백), 재크롤링. web_kg renderDkgDetail 포트.
import { useState } from "react";
import { api, post } from "../../lib/api";
import { useStore } from "../../lib/store";
import type { DkgDetailData, RecrawlDocSummary, RecrawlRun } from "../../lib/types";

interface HistRow { recipe_id: string; status: string; created_at?: string; note?: string }

interface Props {
  g: DkgDetailData;
  recrawlRun: RecrawlRun | null;
  recrawlBusy: boolean;
  onStartRecrawl: (mode: string) => void;
  onOpenSource: () => void;
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
  onStartRecrawl, onOpenSource, onBackDomain }: Props) {
  const s = useStore();
  const [status, setStatus] = useState("");
  const [hist, setHist] = useState<HistRow[] | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const [mode, setMode] = useState("fill");

  const color = s.dkgColor(g.id);
  const selDoc = (g.member_documents || []).find((d) => d.document_id === s.selDkgDoc);
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
      <div className="sub">문서군은 공유 양식(템플릿)으로 정의됩니다 — 양식과,
        그 인스턴스인 소속 문서를 보여줍니다.</div>
      <div className="metricGrid">
        <div className="metric"><span>소속 문서</span><b>{g.member_document_count}</b></div>
        <div className="metric"><span>Domain Node</span><b>{g.domain_node_ids.length}</b></div>
        <div className="metric"><span>Source 위치</span><b>{g.source_location_count}</b></div>
        <div className="metric"><span>값</span><b>{g.value_count.toLocaleString()}</b></div>
      </div>

      <div style={{ marginTop: 13 }} className="kicker">TEMPLATES (양식)</div>
      {(g.parsing_templates || []).length ? (g.parsing_templates || []).map((t) => (
        <div key={`${t.template_name}-${t.version}`} className="dkgCard"
          style={{ cursor: "default", borderLeft: "4px solid var(--purple)" }}>
          <b style={{ color: "var(--purple)" }}>▣ {t.template_name}{" "}
            <span className="badge blue">v{t.version}</span></b>
          <div>{t.documents.length}개 문서 · Override 문서 {t.override_documents} ·
            검토 {t.review_required} · 실패 {t.failed}</div>
          <div style={{ marginTop: 6 }}>
            {t.documents.map((d) => (
              <span className="chip" title={d.status} key={d.filename}>▤ {d.filename}
                {d.override_count ? <b style={{ color: "var(--amber)" }}> override {d.override_count}</b> : null}
                {d.status === "REVIEW_REQUIRED" ? <b style={{ color: "var(--amber)" }}> 검토 필요</b> : null}
              </span>
            ))}
          </div>
        </div>
      )) : (
        <div className="sub" style={{ fontSize: 12 }}>
          배정된 양식(Parsing Template)이 없습니다 — 이 문서군의 문서는 기존
          KG/레시피 흐름으로 유지됩니다.</div>
      )}
      <div className="sub" style={{ fontSize: 11 }}>
        ▣ 문서군의 1차 연결은 양식입니다 — 아래 문서는 양식의 인스턴스이며,
        양식 미배정 문서도 멤버십(포함/제외)으로 직접 연결될 수 있습니다.</div>

      <div style={{ marginTop: 13 }} className="kicker">MEMBER DOCUMENTS (인스턴스)</div>
      <div style={{ maxHeight: "24vh", overflowY: "auto" }}>
        {(g.member_documents || []).map((d) => (
          <div key={d.document_id}
            className={`fileRow${s.selDkgDoc === d.document_id ? " sel" : ""}`}
            onClick={() => s.setSelDkgDoc(d.document_id)}>
            <b>{d.filename}</b>
            {d.override === "INCLUDED" && <span className="badge blue"> 고정</span>}
            <div>{d.nodes.slice(0, 4).join(" · ") || "(매핑 없음)"} · {d.sources} src{" "}
              <button title="이 그룹에서 제외 (매핑/빌드 소스는 유지)"
                style={{ border: 0, background: "none", color: "var(--red)", cursor: "pointer" }}
                onClick={(ev) => { ev.stopPropagation(); member(d.document_id, "EXCLUDED"); }}>
                제외</button>
            </div>
          </div>
        ))}
      </div>
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
        <button className="primary" disabled={!selDoc} onClick={onOpenSource}>
          선택 문서의 원본 위치 보기</button>
        <button className="secondary" onClick={onBackDomain}>전체 KG로 돌아가기</button>
      </div>
      <div className="status">{status}</div>
    </>
  );
}
