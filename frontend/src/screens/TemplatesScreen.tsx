// 5. 템플릿 관리 — 파싱 템플릿의 목록/생성/버전/라이프사이클과 문서 배정을
//    한 화면에서 다룬다. 문서:템플릿은 N:M — 템플릿마다 파싱 관점이 다르다.
import { useCallback, useEffect, useState } from "react";
import { api, del, patch, post } from "../lib/api";
import { useStore } from "../lib/store";
import type { ParsingTemplateRow, TemplateAssignmentRow,
              TemplateVersionDetail } from "../lib/types";

const LIFECYCLES = ["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"];
const LC_BADGE: Record<string, string> = {
  DRAFT: "amber", ACTIVE: "green", DEPRECATED: "", ARCHIVED: "red" };

const SPEC_PLACEHOLDER = `{
  "sheet_templates": [{
    "name": "example",
    "match": {"name_regex": ".*"},
    "mappings": [{
      "key": "temperature", "concept_id": "oven_temperature",
      "source": {"range": "B2:B2"}, "type": "number", "unit": "C"
    }]
  }]
}`;

export default function TemplatesScreen() {
  const s = useStore();
  const [list, setList] = useState<ParsingTemplateRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [selVer, setSelVer] = useState<number | null>(null);
  const [verDetail, setVerDetail] = useState<TemplateVersionDetail | null>(null);
  const [assigned, setAssigned] = useState<TemplateAssignmentRow[]>([]);
  const [status, setStatus] = useState("");
  const [assignDoc, setAssignDoc] = useState("");
  const [specText, setSpecText] = useState("");
  const [showNewVer, setShowNewVer] = useState(false);
  const [form, setForm] = useState({ id: "", name: "", dkg: "", spec: "" });
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    try {
      const rows: ParsingTemplateRow[] = await api("/api/parsing/templates");
      setList(rows);
      return rows;
    } catch { setList([]); return []; }
  }, []);

  useEffect(() => {
    if (s.screen !== "templates") return;
    load().catch(() => {});
    s.loadFiles().catch(() => {});    // 배정 대상 문서 목록
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.screen]);

  const openVersion = useCallback(async (tid: string, ver: number | null) => {
    setSel(tid);
    setSelVer(ver);
    setVerDetail(null);
    setAssigned([]);
    setShowNewVer(false);
    if (ver == null) return;
    try {
      const [detail, docs] = await Promise.all([
        api(`/api/parsing/templates/${tid}/versions/${ver}`),
        api(`/api/parsing/templates/${tid}/versions/${ver}/documents`),
      ]);
      setVerDetail(detail);
      setAssigned(docs);
    } catch (e: any) { setStatus(e.message); }
  }, []);

  const selectTemplate = (t: ParsingTemplateRow) => {
    setStatus("");
    openVersion(t.template_id, t.current_version).catch(() => {});
  };

  const setLifecycle = async (tid: string, lifecycle: string) => {
    try {
      await patch(`/api/parsing/templates/${tid}`, { lifecycle });
      await load();
      setStatus(`라이프사이클 → ${lifecycle}`);
    } catch (e: any) { setStatus(e.message); }
  };

  const addVersion = async () => {
    if (!sel) return;
    try {
      const spec = JSON.parse(specText);
      const r = await api(`/api/parsing/templates/${sel}/versions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }) });
      setSpecText("");
      setStatus(`✓ v${r.version} 추가됨`);
      await load();
      await openVersion(sel, r.version);
    } catch (e: any) {
      setStatus(e instanceof SyntaxError ? `spec JSON 오류: ${e.message}` : e.message);
    }
  };

  const assignSelected = async () => {
    if (!sel || selVer == null || !assignDoc) return;
    const f = s.files.find((x) => x.document_id === assignDoc);
    if (!f || !f.current_version) { setStatus("문서 버전을 찾을 수 없습니다"); return; }
    try {
      await post(`/api/parsing/documents/${f.document_id}/assign`, {
        document_version: f.current_version, template_id: sel, template_version: selVer });
      setStatus(`✓ ${f.filename} 배정됨`);
      await load();
      await openVersion(sel, selVer);
      await s.loadFiles();            // 파일 분석 탭 배지 갱신
    } catch (e: any) { setStatus(e.message); }
  };

  const unassign = async (row: TemplateAssignmentRow) => {
    try {
      await del(`/api/parsing/documents/${row.document_id}/assignments/` +
        `${row.template_id}?document_version=${encodeURIComponent(row.document_version)}`);
      setStatus(`✓ ${row.filename || row.document_id} 해제됨`);
      await load();
      if (sel && selVer != null) await openVersion(sel, selVer);
      await s.loadFiles();
    } catch (e: any) { setStatus(e.message); }
  };

  const createTemplate = async () => {
    const id = form.id.trim(), name = form.name.trim();
    if (!id || !name) { setStatus("template_id와 이름은 필수입니다"); return; }
    try {
      await post("/api/parsing/templates", {
        template_id: id, name, target_document_kg: form.dkg || null });
      if (form.spec.trim()) {
        const spec = JSON.parse(form.spec);
        await post(`/api/parsing/templates/${id}/versions`, { spec });
      }
      setForm({ id: "", name: "", dkg: "", spec: "" });
      setShowNew(false);
      setStatus(`✓ 템플릿 ${name} 생성됨`);
      const rows = await load();
      const created = rows.find((t) => t.template_id === id);
      if (created) selectTemplate(created);
    } catch (e: any) {
      setStatus(e instanceof SyntaxError ? `spec JSON 오류: ${e.message}` : e.message);
    }
  };

  const selRow = list.find((t) => t.template_id === sel) || null;
  const assignable = s.files.filter((f) =>
    !assigned.some((a) => a.document_id === f.document_id));

  return (
    <section className={`screen${s.screen === "templates" ? " active" : ""}`}>
      <div style={{ display: "grid", gridTemplateColumns: "5fr 7fr", gap: 14,
        alignItems: "start" }}>
        <div className="panel pad">
          <div className="kicker">Parsing Templates</div>
          <div className="title">템플릿 관리</div>
          <div className="sub">파싱 템플릿의 버전과 문서 배정을 관리합니다. 한 문서에
            관점이 다른 템플릿 여러 개를 배정할 수 있습니다.</div>
          <table className="table" style={{ marginTop: 10 }}>
            <thead><tr><th>템플릿</th><th>라이프사이클</th><th>버전</th><th>배정 문서</th></tr></thead>
            <tbody>
              {list.length ? list.map((t) => (
                <tr key={t.template_id} style={{ cursor: "pointer" }}
                  className={sel === t.template_id ? "sel" : ""}
                  onClick={() => selectTemplate(t)}>
                  <td><b>{t.name}</b>
                    <div className="sub" style={{ fontSize: 11 }}>{t.template_id}
                      {t.target_document_kg ? ` · ${t.target_document_kg}` : ""}</div></td>
                  <td><span className={`badge ${LC_BADGE[t.lifecycle] || ""}`}>
                    {t.lifecycle}</span></td>
                  <td>{t.versions.length ? `v${t.current_version} (${t.versions.length}개)` : "—"}</td>
                  <td>{t.assigned_documents}</td>
                </tr>
              )) : (
                <tr><td colSpan={4} className="empty">템플릿이 없습니다 — 아래에서 만드세요</td></tr>
              )}
            </tbody>
          </table>
          {showNew ? (
            <div className="editForm" style={{ marginTop: 12 }}>
              <div className="kicker">새 템플릿</div>
              <input placeholder="template_id (영문/숫자/_)" value={form.id}
                onChange={(e) => setForm({ ...form, id: e.target.value })} />
              <input placeholder="이름" value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <select value={form.dkg}
                onChange={(e) => setForm({ ...form, dkg: e.target.value })}>
                <option value="">대상 문서군 없음</option>
                {s.dkgs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
              <textarea rows={7} placeholder={`초기 spec JSON (선택)\n${SPEC_PLACEHOLDER}`}
                value={form.spec} style={{ fontFamily: "monospace", fontSize: 11 }}
                onChange={(e) => setForm({ ...form, spec: e.target.value })} />
              <div style={{ display: "flex", gap: 6 }}>
                <button className="primary" onClick={createTemplate}>생성</button>
                <button className="secondary" onClick={() => setShowNew(false)}>취소</button>
              </div>
            </div>
          ) : (
            <button className="secondary" style={{ marginTop: 10 }}
              onClick={() => setShowNew(true)}>+ 새 템플릿</button>
          )}
        </div>

        <div className="panel pad">
          {!selRow ? (
            <div className="empty">왼쪽에서 템플릿을 선택하세요</div>
          ) : (
            <>
              <div className="kicker">Template Detail</div>
              <div className="title">{selRow.name}</div>
              <div className="sub">{selRow.template_id}
                {selRow.target_document_kg ? ` · 대상 문서군 ${selRow.target_document_kg}` : ""}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center",
                marginTop: 8, flexWrap: "wrap" }}>
                <label style={{ fontSize: 11, color: "var(--muted)" }}>라이프사이클</label>
                <select value={selRow.lifecycle}
                  onChange={(e) => setLifecycle(selRow.template_id, e.target.value)}>
                  {LIFECYCLES.map((l) => <option key={l}>{l}</option>)}
                </select>
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {selRow.versions.map((v) => (
                    <span key={v} className={`chip pick${selVer === v ? " sel" : ""}`}
                      onClick={() => openVersion(selRow.template_id, v)}>v{v}</span>
                  ))}
                </span>
                {showNewVer ? null : (
                  <button className="secondary" onClick={() => setShowNewVer(true)}>
                    + 새 버전</button>
                )}
              </div>
              {showNewVer && (
                <div className="editForm" style={{ marginTop: 8 }}>
                  <textarea rows={9} placeholder={SPEC_PLACEHOLDER} value={specText}
                    style={{ fontFamily: "monospace", fontSize: 11, width: "100%" }}
                    onChange={(e) => setSpecText(e.target.value)} />
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="primary" onClick={addVersion}>버전 추가</button>
                    <button className="secondary"
                      onClick={() => setShowNewVer(false)}>취소</button>
                  </div>
                </div>
              )}

              {verDetail && (
                <>
                  <div className="kicker" style={{ marginTop: 14 }}>
                    v{verDetail.version} — 추출 매핑</div>
                  <table className="table" style={{ marginTop: 6 }}>
                    <thead><tr><th>시트 템플릿</th><th>키</th><th>개념</th>
                      <th>소스</th><th>단위</th></tr></thead>
                    <tbody>
                      {verDetail.sheet_templates.flatMap((st) =>
                        st.mappings.map((m) => (
                          <tr key={`${st.name}:${m.mapping_key}`}>
                            <td>{st.name}</td>
                            <td><b>{m.mapping_key}</b></td>
                            <td>{m.concept_id || "—"}</td>
                            <td style={{ fontFamily: "monospace", fontSize: 11 }}>
                              {JSON.stringify(m.source)}</td>
                            <td>{m.unit || "—"}</td>
                          </tr>
                        )))}
                      {!verDetail.sheet_templates.some((st) => st.mappings.length) && (
                        <tr><td colSpan={5} className="empty">매핑이 없습니다</td></tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}

              <div className="kicker" style={{ marginTop: 14 }}>
                배정된 문서 {assigned.length ? `(${assigned.length})` : ""}</div>
              <table className="table" style={{ marginTop: 6 }}>
                <thead><tr><th>문서</th><th>상태</th><th></th></tr></thead>
                <tbody>
                  {assigned.length ? assigned.map((a) => (
                    <tr key={a.document_id}>
                      <td>{a.filename || a.document_id}</td>
                      <td><span className={`badge ${a.status === "REVIEW_REQUIRED"
                        ? "amber" : a.status === "FAILED" ? "red" : ""}`}>
                        {a.status}</span></td>
                      <td><button className="secondary"
                        onClick={() => unassign(a)}>해제</button></td>
                    </tr>
                  )) : (
                    <tr><td colSpan={3} className="empty">
                      이 버전에 배정된 문서가 없습니다</td></tr>
                  )}
                </tbody>
              </table>
              {selVer != null && (
                <div style={{ display: "flex", gap: 6, marginTop: 8 }} className="editForm">
                  <select value={assignDoc} style={{ flex: 1, marginTop: 0 }}
                    onChange={(e) => setAssignDoc(e.target.value)}>
                    <option value="">배정할 문서 선택…</option>
                    {assignable.map((f) => (
                      <option key={f.document_id} value={f.document_id}>{f.filename}</option>
                    ))}
                  </select>
                  <button className="primary" disabled={!assignDoc}
                    onClick={assignSelected}>v{selVer}로 배정</button>
                </div>
              )}
            </>
          )}
          <div className="status" style={{ marginTop: 8 }}>{status}</div>
        </div>
      </div>
    </section>
  );
}
