// Domain Concept 편집기 (KG2) — 생성/부분 수정/별칭/관계/폐기.
// web_kg openConceptEditor 포트.
import { useCallback, useEffect, useState } from "react";
import { api, del, post } from "../../lib/api";
import { useStore } from "../../lib/store";
import type { ConceptDetail } from "../../lib/types";

const REL_TYPES = ["IS_A", "PART_OF", "AFFECTS", "MEASURED_BY", "RELATED_TO"];
const EMPTY: ConceptDetail = { concept: {}, aliases: [], relations: [], active_mappings: 0 };

interface Props {
  cid: string | null;
  onCreated: (conceptId: string) => void;
  onBack: (cid: string) => void;
}

export default function ConceptEditor({ cid, onCreated, onBack }: Props) {
  const s = useStore();
  const [d, setD] = useState<ConceptDetail>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [form, setForm] = useState({ name: "", en: "", desc: "", lvl: "", dt: "", unit: "" });
  const [newAlias, setNewAlias] = useState("");
  const [relType, setRelType] = useState(REL_TYPES[0]);
  const [relTarget, setRelTarget] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!cid) { setD(EMPTY); return; }
    try {
      const r = await api(`/api/kg/concept/${encodeURIComponent(cid)}`);
      setD(r);
      setLoadError(null);
      const c = r.concept || {};
      setForm({ name: c.canonical_name || "", en: c.canonical_name_en || "",
        desc: c.description || "", lvl: c.domain_level || "",
        dt: c.data_type || "", unit: c.canonical_unit || "" });
    } catch (e: any) { setLoadError(e.message); }
  }, [cid]);

  useEffect(() => { load(); }, [load]);

  if (loadError) return <div className="empty">{loadError}</div>;

  const c = d.concept || {};
  const nameOf = (id: string) =>
    (s.domain?.nodes.find((x) => x.id === id) || { name: id }).name;
  const relTargets = s.concepts.filter((x) => x.concept_id !== cid);

  const save = async () => {
    setSaving(true);           // 연타 시 새 개념 이중 생성 방지
    const body = {
      concept_id: cid || undefined,
      canonical_name: form.name.trim() || null,
      canonical_name_en: form.en.trim() || null,
      description: form.desc.trim() || null,
      domain_level: form.lvl || null,
      data_type: form.dt || null,
      canonical_unit: form.unit.trim() || null,
    };
    try {
      const r = await post("/api/kg/concept", body);
      await s.reloadKg();
      setStatus(`✓ 저장됨 (${r.concept_id})`);
      if (r.created) onCreated(r.concept_id);
      else { setSaving(false); load(); }
    } catch (e: any) { setStatus(e.message); setSaving(false); }
  };

  const wrap = (fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (e: any) { setStatus(e.message); }
  };

  const sel = (label: string, key: "lvl" | "dt", options: string[], extra?: string) => (
    <>
      <label>{label} {extra && <span className="muted">{extra}</span>}</label>
      <select value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
        {options.map((v) => <option key={v} value={v}>{v || "—"}</option>)}
      </select>
    </>
  );

  return (
    <>
      <div className="kicker">{cid ? "EDIT DOMAIN NODE" : "NEW DOMAIN NODE"}</div>
      <div className="title">{c.canonical_name || "새 개념"}</div>
      {c.status === "DEPRECATED" && <span className="badge red">폐기됨</span>}
      {cid && <div className="sub">활성 매핑 {d.active_mappings}건이 이 개념을 참조합니다.</div>}
      <div className="editForm">
        <label>이름 (canonical_name)</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label>영문명</label>
        <input value={form.en} onChange={(e) => setForm({ ...form, en: e.target.value })} />
        <label>설명</label>
        <textarea rows={2} value={form.desc}
          onChange={(e) => setForm({ ...form, desc: e.target.value })} />
        {sel("레벨", "lvl", ["", "L1", "L2", "L3"], "(L1 = Document KG 축)")}
        {sel("데이터 타입", "dt", ["", "numeric", "text", "category", "datetime", "flag"])}
        <label>기준 단위</label>
        <input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
      </div>
      {cid && (
        <>
          <div className="kicker" style={{ marginTop: 12 }}>ALIASES</div>
          <div>
            {d.aliases.length ? d.aliases.map((a) => (
              <span className="chip" key={a}>{a}
                <button onClick={wrap(async () => {
                  await del(`/api/kg/alias?concept_id=${encodeURIComponent(cid)}&alias=${encodeURIComponent(a)}`);
                  load();
                })}>✕</button></span>
            )) : <span className="empty">없음</span>}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }} className="editForm">
            <input placeholder="새 별칭" style={{ flex: 1, marginTop: 0 }} value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)} />
            <button className="secondary" onClick={wrap(async () => {
              const a = newAlias.trim();
              if (!a) return;
              await post("/api/kg/alias", { concept_id: cid, alias: a });
              setStatus("✓ 별칭 추가 — 미매핑을 재평가하려면 해당 DKG에서 재크롤링(fill)하세요");
              setNewAlias("");
              load();
            })}>추가</button>
          </div>
          <div className="kicker" style={{ marginTop: 12 }}>RELATIONS</div>
          <div>
            {d.relations.length ? d.relations.map((r) => (
              <span className="chip" key={`${r.source_concept_id}|${r.target_concept_id}|${r.relation_type}`}>
                {nameOf(r.source_concept_id)} —{r.relation_type}→ {nameOf(r.target_concept_id)}
                <button onClick={wrap(async () => {
                  const res = await del(`/api/kg/relation?source=${encodeURIComponent(r.source_concept_id)}&target=${encodeURIComponent(r.target_concept_id)}&type=${encodeURIComponent(r.relation_type)}`);
                  if (res.warning) setStatus(`⚠ ${res.warning}`);
                  load();
                })}>✕</button></span>
            )) : <span className="empty">없음</span>}
          </div>
          <div className="editForm"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
            <select value={relType} onChange={(e) => setRelType(e.target.value)}>
              {REL_TYPES.map((t) => <option key={t}>{t}</option>)}
            </select>
            <select value={relTarget} onChange={(e) => setRelTarget(e.target.value)}>
              <option value="">— 대상 —</option>
              {relTargets.map((x) => (
                <option key={x.concept_id} value={x.concept_id}>{x.canonical_name}</option>
              ))}
            </select>
            <button className="secondary" style={{ gridColumn: "1/3" }} onClick={wrap(async () => {
              if (!relTarget) { setStatus("대상 개념을 선택하세요."); return; }
              const r = await post("/api/kg/relation",
                { source: cid, target: relTarget, type: relType });
              if (r.warning) setStatus(`⚠ ${r.warning}`);
              await s.reloadKg();
              load();
            })}>이 개념 → 대상 관계 추가</button>
          </div>
        </>
      )}
      <div className="rightBtns">
        <button className="primary" disabled={saving} onClick={save}>저장</button>
        {cid && (c.status === "DEPRECATED" ? (
          <button className="secondary" onClick={wrap(async () => {
            await post(`/api/kg/concept/${encodeURIComponent(cid)}/restore`, {});
            await s.reloadKg();
            load();
          })}>복원</button>
        ) : (
          <button className="secondary" onClick={wrap(async () => {
            // 409: 활성 매핑 n건 참조 안내
            await post(`/api/kg/concept/${encodeURIComponent(cid)}/deprecate`, {});
            await s.reloadKg();
            load();
          })}>폐기</button>
        ))}
        {cid && <button className="secondary" onClick={() => onBack(cid)}>돌아가기</button>}
      </div>
      <div className="status">{status}</div>
    </>
  );
}
