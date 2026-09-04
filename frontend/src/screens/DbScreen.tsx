// 4. 통합 DB — 3단계: ①데이터 선택(개념→양식→문서) ②스키마 확인
//    ③생성·다운로드. 생성된 DB는 .db/.csv 파일로 바로 내려받는다.
import { useEffect, useMemo, useState } from "react";
import { api, post } from "../lib/api";
import type { CartItem } from "../lib/api";
import { useStore } from "../lib/store";
import type { BuildResult, Proposal, SearchResult, SearchSource } from "../lib/types";

const ETC = "기타 (양식 미배정)";

// ① 데이터 선택 — 개념 '트리'에서 체크한다. 상위 개념을 체크하면 하위 개념이
// 일괄 선택되고, 양식 카드에서 전처리/문서별 가감을 조정한다.
// 검토 대기 소스는 승인 전까지 제외.
interface NormPreset { id: string; label: string }
interface SrcEntry { src: SearchSource; cid: string }

function MergePicker() {
  const s = useStore();
  const [srcCache, setSrcCache] = useState<Record<string, SearchSource[]>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [closed, setClosed] = useState<Record<string, boolean>>({});  // 트리 접힘
  const [busyTree, setBusyTree] = useState(false);
  const [presets, setPresets] = useState<NormPreset[]>([]);

  useEffect(() => {   // 도메인 정규화 프리셋 (normalizers.yaml) — 코드 고정 아님
    api("/api/normalizers")
      .then((r) => setPresets(r.presets || []))
      .catch(() => setPresets([]));
  }, []);

  const cart = s.cartItems();               // cartCount 변경 시 리렌더로 최신화
  const inCart = new Set(cart.map((x) => x.node_id));

  // ---- 온톨로지 트리 (개념 탐색과 같은 /api/kg/domain 데이터) ----
  const { childrenOf, roots, nodeById } = useMemo(() => {
    const nodes = s.domain?.nodes || [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ch = new Map<string, typeof nodes>();
    for (const n of nodes)
      if (n.parent && byId.has(n.parent))
        ch.set(n.parent, [...(ch.get(n.parent) || []), n]);
    return { childrenOf: ch,
             roots: nodes.filter((n) => !n.parent || !byId.has(n.parent)),
             nodeById: byId };
  }, [s.domain]);

  const subtree = (id: string): string[] => {
    const out = [id];
    for (const c of childrenOf.get(id) || []) out.push(...subtree(c.id));
    return out;
  };
  const subtreeSources = (id: string) => subtree(id)
    .reduce((n, c) => n + (nodeById.get(c)?.sources || 0), 0);

  const usable = (cid: string, cache?: Record<string, SearchSource[]>) =>
    ((cache || srcCache)[cid] || []).filter((x) => x.status !== "REVIEW_REQUIRED");

  const ensure = async (cids: string[]) => {
    const missing = cids.filter((c) => !(c in srcCache));
    if (!missing.length) return srcCache;
    const fetched = await Promise.all(missing.map((c) =>
      api(`/api/search?concept=${encodeURIComponent(c)}`)
        .then((r: SearchResult) => [c, r.sources || []] as const)
        .catch(() => [c, []] as const)));
    const next = { ...srcCache, ...Object.fromEntries(fetched) };
    setSrcCache(next);
    return next;
  };

  // localStorage 복원 대비 — 담긴 개념들의 소스 캐시를 확보해 양식 카드를 그린다
  useEffect(() => {
    const cids = [...new Set(cart.map((x) => x.concept_id).filter(Boolean))] as string[];
    if (cids.some((c) => !(c in srcCache))) ensure(cids).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cartCount]);

  // 개념(서브트리) 체크 상태: 담긴 수 vs 기대 수(캐시 기준)
  const conceptState = (cid: string) => {
    let carted = 0, expected = 0;
    for (const c of subtree(cid)) {
      const items = cart.filter((x) => x.concept_id === c).length;
      carted += items;
      expected += c in srcCache ? usable(c).length : items;
    }
    return { checked: expected > 0 && carted >= expected,
             some: carted > 0 && carted < expected };
  };

  // 상위 개념 체크 → 하위 개념까지 일괄 담기 / 해제
  const toggleConcept = async (cid: string) => {
    const ids = subtree(cid);
    const st = conceptState(cid);
    if (st.checked || st.some) {
      const drop = new Set(ids);
      s.saveCart(cart.filter((x) => !drop.has(x.concept_id || "")));
      return;
    }
    setBusyTree(true);
    try {
      const cache = await ensure(ids);
      const add: CartItem[] = [];
      for (const c of ids)
        for (const src of usable(c, cache))
          if (!inCart.has(src.node_id)) add.push(toCartItem(src, c, "auto"));
      s.saveCart([...cart, ...add]);
    } finally { setBusyTree(false); }
  };

  const formOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of s.files)
      if (f.template_name)
        m.set(f.document_id, `${f.template_name} v${f.template_version}`);
    return m;
  }, [s.files]);

  // 양식 그룹 — 담긴 개념들의 소스를 합산해서 그린다 (다중 개념)
  const cartConceptIds = [...new Set(cart.map((x) => x.concept_id)
    .filter(Boolean))] as string[];
  const groups = useMemo(() => {
    const by = new Map<string, { docs: Map<string, SrcEntry[]>; review: number }>();
    for (const cid of cartConceptIds) {
      for (const src of srcCache[cid] || []) {
        const label = formOf.get(src.document_id) || ETC;
        const g = by.get(label) || { docs: new Map(), review: 0 };
        if (src.status === "REVIEW_REQUIRED") g.review += 1;
        else {
          const list = g.docs.get(src.document_id) || [];
          list.push({ src, cid });
          g.docs.set(src.document_id, list);
        }
        by.set(label, g);
      }
    }
    return [...by.entries()]
      .sort(([a], [b]) => (a === ETC ? 1 : b === ETC ? -1 : a.localeCompare(b, "ko")))
      .map(([label, g]) => ({ label, ...g,
        nodeIds: [...g.docs.values()].flat().map((e) => e.src.node_id) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartConceptIds.join("|"), srcCache, formOf]);

  // 전처리 값: "auto" | "raw" | "p:<프리셋 id>"
  const toCartItem = (src: SearchSource, cid: string, prep: string): CartItem => ({
    node_id: src.node_id, concept_id: cid, header: src.header,
    document: src.document, sheet: src.sheet,
    range: (src.locator || "").split("!").pop() || "", role: null,
    raw: prep === "raw",
    preset: prep.startsWith("p:") ? prep.slice(2) : null });

  const prepOf = (items: CartItem[]): string => {
    if (!items.length) return "auto";
    if (items.every((x) => x.raw)) return "raw";
    const p = items[0].preset;
    if (p && items.every((x) => x.preset === p)) return `p:${p}`;
    return "auto";
  };

  const addEntries = (entries: SrcEntry[], prep: string) => {
    const add = entries.filter((e) => !inCart.has(e.src.node_id))
      .map((e) => toCartItem(e.src, e.cid, prep));
    s.saveCart([...cart, ...add]);
  };
  const removeNodes = (nodeIds: string[]) => {
    const drop = new Set(nodeIds);
    s.saveCart(cart.filter((x) => !drop.has(x.node_id)));
  };

  // ---- 트리 렌더 (재귀) ----
  const renderNode = (n: { id: string; name: string; sources: number },
                      depth: number): React.ReactNode => {
    const kids = childrenOf.get(n.id) || [];
    const mappable = subtreeSources(n.id);
    const st = conceptState(n.id);
    return (
      <div key={n.id}>
        <div style={{ paddingLeft: depth * 16, display: "flex", gap: 5,
          alignItems: "center", lineHeight: "22px" }}>
          {kids.length ? (
            <span style={{ cursor: "pointer", width: 13, color: "var(--muted)",
              userSelect: "none" }}
              onClick={() => setClosed((m) => ({ ...m, [n.id]: !m[n.id] }))}>
              {closed[n.id] ? "▸" : "▾"}</span>
          ) : <span style={{ width: 13 }} />}
          <label style={{ display: "flex", gap: 5, alignItems: "center",
            cursor: mappable ? "pointer" : "default",
            color: mappable ? "inherit" : "var(--muted)",
            fontWeight: kids.length ? 700 : 400, fontSize: 12 }}>
            <input type="checkbox" disabled={!mappable || busyTree}
              checked={st.checked}
              ref={(el) => { if (el) el.indeterminate = st.some; }}
              onChange={() => toggleConcept(n.id)} />
            {n.name}
            <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
              {mappable ? `· 위치 ${mappable}` : "· 소스 없음"}
              {kids.length ? " (하위 포함)" : ""}</span>
          </label>
        </div>
        {!closed[n.id] && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="schemaCard">
      <h4 style={{ margin: "0 0 4px" }}>① 데이터 선택</h4>
      <div className="sub" style={{ marginBottom: 8 }}>
        개념 트리에서 체크하세요 — <b>상위 개념을 체크하면 하위 개념이 일괄
        선택</b>됩니다. 담긴 데이터는 아래 양식 카드에서 전처리/문서별로
        조정합니다.</div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 10,
        padding: "8px 10px", maxHeight: 300, overflowY: "auto",
        opacity: busyTree ? 0.6 : 1 }}>
        {roots.length
          ? roots.map((r) => renderNode(r, 0))
          : <div className="empty">온톨로지가 비어 있습니다</div>}
      </div>
      {cart.length > 0 && !groups.length && (
        <div className="empty">담긴 개념의 소스 정보를 불러오는 중…</div>
      )}
      {groups.map((g) => {
        const carted = g.nodeIds.filter((id) => inCart.has(id));
        const all = carted.length === g.nodeIds.length && g.nodeIds.length > 0;
        const some = carted.length > 0 && !all;
        const cartedItems = cart.filter((x) => carted.includes(x.node_id));
        const prep = prepOf(cartedItems);
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
                    : addEntries([...g.docs.values()].flat(), prep)} />
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
                  const v = e.target.value;
                  const raw = v === "raw";
                  const preset = v.startsWith("p:") ? v.slice(2) : null;
                  const ids = new Set(carted);
                  s.saveCart(cart.map((x) =>
                    ids.has(x.node_id) ? { ...x, raw, preset } : x));
                }}>
                <option value="auto">전처리: 자동 정규화 (단위→기준)</option>
                <option value="raw">전처리: 원값 유지 (변환 생략)</option>
                {presets.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>전처리: {p.label}</option>
                ))}
              </select>
              <button className="secondary" style={{ padding: "4px 8px", fontSize: 11 }}
                onClick={() => setOpen((m) => ({ ...m, [g.label]: !m[g.label] }))}>
                {open[g.label] ? "접기" : "문서별 조정"}</button>
            </div>
            {open[g.label] && (
              <div style={{ marginTop: 6 }}>
                {[...g.docs.entries()].map(([docId, entries]) => {
                  const docCarted = entries.filter((e) => inCart.has(e.src.node_id));
                  const docAll = docCarted.length === entries.length;
                  return (
                    <label key={docId} className="fileRow"
                      style={{ display: "block", paddingLeft: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={docAll}
                        ref={(el) => {
                          if (el) el.indeterminate = docCarted.length > 0 && !docAll;
                        }}
                        onChange={() => docAll
                          ? removeNodes(entries.map((e) => e.src.node_id))
                          : addEntries(entries, prep)} />{" "}
                      <b>▤ {entries[0].src.document}</b>
                      <span className="muted" style={{ fontSize: 11 }}>
                        {" "}· 위치 {entries.length} · 반영 {docCarted.length}</span>
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
        // 양식별 정규화 프리셋 — 프리셋 id를 서버가 normalizers.yaml에서 해석
        normalize_rules: Object.entries(
          cart.reduce<Record<string, string[]>>((m, x) => {
            if (x.preset) (m[x.preset] = m[x.preset] || []).push(x.node_id);
            return m;
          }, {})).map(([preset, node_ids]) => ({ preset, node_ids })),
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
