// Semantic Excel Integration — S01 파일분석 / S02+S03 KG탐색+Semantic Viewer / S04+S05 통합DB.
// 탐색 축은 KG 노드(§12): 노드를 고르면 서비스가 원본 위치를 찾아주고,
// 검증은 원본 렌더(그리드) 위 Overlay에서, 포함 결정은 통합 초안(cart)에 저장된다.
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  return r.json();
}

const ROLE_PILL = { KEY: 'pkey', VALUE: 'pvalue', CONTEXT: 'pctx' };
const state = { doc: null, sheet: null, seq: 0, overlay: [], selNode: null, concepts: [] };

// ------------------------------------------------- 통합 초안 (cart, §7.2) ----
const CART_KEY = 'kg_cart_v1';
function cart() { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; } }
function saveCart(c) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch {}
  $('#cartN').textContent = c.length ? `(${c.length})` : '';
  renderCart();
}
function addToCart(item) {
  const c = cart();
  if (!c.some((x) => x.node_id === item.node_id)) c.push(item);
  saveCart(c);
}
function dropFromCart(nodeId) { saveCart(cart().filter((x) => x.node_id !== nodeId)); }

// ---------------------------------------------------------------- 탭 전환 ----
const tabs = [...document.querySelectorAll('[data-tab]')];
function show(id) {
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'build') refreshProposal();
}
tabs.forEach((b) => b.onclick = () => show(b.dataset.tab));

// ------------------------------------------------------- S01 파일 분석 ----
const BADGE = { READY: ['b-ready', 'Ready'], REVIEW_REQUIRED: ['b-review', 'Review'],
                ERROR: ['b-error', 'Error'] };
async function loadFiles() {
  const files = await api('/api/files');
  const n = (s) => files.filter((f) => f.status === s).length;
  $('#fileStats').innerHTML = [
    ['전체 파일', files.length], ['Ready', n('READY')],
    ['검토 필요', n('REVIEW_REQUIRED')], ['오류', n('ERROR')],
  ].map(([k, v]) => `<div class="stat">${k}<b>${v}</b></div>`).join('');
  $('#fileRows').innerHTML = files.map((f) => {
    const [cls, label] = BADGE[f.status] || ['', f.status];
    return `<tr><td><b>${esc(f.filename)}</b></td>
      <td><span class="badge ${cls}">${label}</span></td>
      <td>${f.sheets}</td><td>${f.coverage_pct}%</td>
      <td>${f.review || '—'}</td>
      <td><button class="btn" data-open="${esc(f.document_id)}">열어보기</button></td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">등록된 파일이 없습니다 — kg ingest를 먼저 실행하세요</td></tr>';
  $('#fileRows').querySelectorAll('[data-open]').forEach((b) => b.onclick = () => {
    show('explore');
    loadSheet(b.dataset.open, null).catch((e) => $('#vstatus').textContent = e.message);
  });
}

// -------------------------------------- S03 Excel Semantic Viewer + Overlay ----
function colName(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function parseRange(range) {
  const one = (a) => {
    const m = /^([A-Z]+)(\d+)$/.exec((a || '').trim());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { c, r: +m[2] };
  };
  const [a, b] = String(range || '').split(':');
  const p1 = one(a), p2 = one(b || a);
  return p1 && p2 ? { r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c),
                      r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) } : null;
}

async function loadSheet(doc, sheet, focusNode) {
  const seq = ++state.seq;
  $('#vstatus').textContent = '불러오는 중…';
  const data = await api(`/api/sheet?doc=${encodeURIComponent(doc)}` +
                         (sheet ? `&name=${encodeURIComponent(sheet)}` : ''));
  if (seq !== state.seq) return;
  let overlay = [];
  try { overlay = await api(`/api/overlay?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(data.sheet)}`); }
  catch {}
  if (seq !== state.seq) return;
  state.doc = doc; state.sheet = data.sheet; state.overlay = overlay;

  $('#vdoc').textContent = '';
  $('#vsheetlbl').textContent = ` Sheet: ${data.sheet}`;
  $('#tabs').innerHTML = data.sheets.map((s) =>
    `<button data-s="${esc(s)}" class="${s === data.sheet ? 'on' : ''}">${esc(s)}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => loadSheet(doc, b.dataset.s));

  // 문서명 표시
  api('/api/files').then((fs) => {
    const f = fs.find((x) => x.document_id === doc);
    if (f && state.doc === doc) $('#vdoc').textContent = f.filename;
  }).catch(() => {});

  // Overlay 좌표층: 셀 → {role, node}
  const ovAt = new Map();
  for (const o of overlay) {
    const rg = parseRange(o.range);
    if (!rg) continue;
    for (let r = rg.r1; r <= rg.r2; r++)
      for (let c = rg.c1; c <= rg.c2; c++)
        if (!ovAt.has(`${r},${c}`)) ovAt.set(`${r},${c}`, o);
  }
  const focusRange = focusNode ? parseRange(
    (overlay.find((o) => o.node_id === focusNode) || {}).range) : null;

  const byPos = new Map();
  for (const c of data.cells) byPos.set(`${c.r},${c.c}`, c);
  const covered = new Set();
  for (const c of data.cells)
    for (let r = c.r; r < c.r + c.rs; r++)
      for (let k = c.c; k < c.c + c.cs; k++)
        if (r !== c.r || k !== c.c) covered.add(`${r},${k}`);

  let html = '<table class="grid"><tr><td class="hd"></td>';
  for (let c = 1; c <= data.max_col; c++) html += `<td class="hd">${colName(c)}</td>`;
  html += '</tr>';
  for (let r = 1; r <= data.max_row; r++) {
    html += `<tr><td class="hd">${r}</td>`;
    for (let c = 1; c <= data.max_col; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = byPos.get(`${r},${c}`);
      const ov = ovAt.get(`${r},${c}`);
      const inFocus = focusRange && r >= focusRange.r1 && r <= focusRange.r2 &&
                      c >= focusRange.c1 && c <= focusRange.c2;
      const cls = (ov ? ` ov ov-${ov.role}` : '') + (inFocus ? ' sel' : '');
      const dat = ov ? ` data-node="${esc(ov.node_id)}"` : '';
      const style = [];
      if (cell && cell.f) style.push(`background:${esc(cell.f)}`);
      if (cell && cell.b) style.push('font-weight:700');
      html += `<td${cls ? ` class="${cls.trim()}"` : ''}${dat}` +
        `${cell && cell.rs > 1 ? ` rowspan="${cell.rs}"` : ''}` +
        `${cell && cell.cs > 1 ? ` colspan="${cell.cs}"` : ''}` +
        `${style.length ? ` style="${style.join(';')}"` : ''}` +
        ` title="${colName(c)}${r}${ov ? ` · ${esc(ov.concept_name || ov.header)} [${ov.role}]` : ''}">` +
        `${cell ? esc(cell.v) : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  $('#gridwrap').innerHTML = html;
  $('#gridwrap').querySelectorAll('td.ov').forEach((td) =>
    td.onclick = () => openInspector(td.dataset.node));
  const roles = { KEY: 0, VALUE: 0, CONTEXT: 0 };
  overlay.forEach((o) => roles[o.role] = (roles[o.role] || 0) + 1);
  $('#vstatus').innerHTML =
    `${data.sheet} — ${data.max_row}×${data.max_col}${data.truncated ? ' (잘림)' : ''} · ` +
    `Overlay <span class="pill pkey">KEY ${roles.KEY}</span> ` +
    `<span class="pill pvalue">VALUE ${roles.VALUE}</span> ` +
    `<span class="pill pctx">CONTEXT ${roles.CONTEXT}</span>`;
  const selCell = $('#gridwrap td.sel');
  if (selCell) selCell.scrollIntoView({ block: 'center', inline: 'center' });
}

// ------------------------------------------------------- S03 Inspector ----
async function openInspector(nodeId) {
  state.selNode = nodeId;
  const d = await api(`/api/source/${encodeURIComponent(nodeId)}`);
  const inCart = cart().some((x) => x.node_id === nodeId);
  const opts = state.concepts.map((c) =>
    `<option value="${esc(c.concept_id)}" ${d.mapping && d.mapping.concept_id === c.concept_id ? 'selected' : ''}>` +
    `${esc(c.canonical_name)} (${esc(c.concept_id)})</option>`).join('');
  $('#inspector').innerHTML = `
    <h3 style="margin:2px 0">선택 영역</h3>
    <h2>${esc(d.range)}</h2>
    <span class="pill ${ROLE_PILL[d.role] || 'pctx'}">${esc(d.role)}</span>
    <span class="muted">${esc(d.header)}</span>
    <div style="margin-top:14px" class="muted">Domain Concept
      ${d.mapping ? `· ${esc(d.mapping.status)} (${d.mapping.confidence})` : '· 미매핑'}</div>
    <select id="conceptSel">${opts}</select>
    <div style="margin-top:14px" class="muted">Value Preview</div>
    <div class="preview">${d.values.map((v, i) =>
      `<span class="muted">${esc(v.key ?? String(i + 1).padStart(2, '0'))}</span>` +
      `<b>${esc(v.value)}</b><span class="muted">${esc(d.unit || '')}</span>`).join('')}</div>
    <div style="margin-top:14px" class="muted">Row Context</div>
    <p style="margin:6px 0">인접: <b>${esc((d.row_context.keys || []).join(', ') || '—')}</b><br>
      Source: <b>${esc(d.sheet)}!${esc(d.range)}</b><br>
      문서: <b>${esc(d.document)}</b></p>
    <button class="btn primary" style="width:100%" id="includeBtn"
      ${inCart ? 'disabled' : ''}>${inCart ? '✓ 이미 포함됨' : '이 위치 포함'}</button>
    <button class="btn" style="width:100%;margin-top:8px" id="remapBtn">매핑 수정</button>
    <div class="status" id="insStatus"></div>`;
  $('#includeBtn').onclick = () => {
    addToCart({ node_id: nodeId, header: d.header, document: d.document,
                sheet: d.sheet, range: d.range,
                concept_id: d.mapping ? d.mapping.concept_id : null, role: d.role });
    $('#insStatus').textContent = '✓ 통합 DB 초안에 포함되었습니다.';
    $('#includeBtn').disabled = true;
    $('#includeBtn').textContent = '✓ 이미 포함됨';
  };
  $('#remapBtn').onclick = async () => {
    const concept_id = $('#conceptSel').value;
    $('#remapBtn').disabled = true;
    try {
      await api('/api/remap', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId, concept_id }) });
      $('#insStatus').textContent = `✓ ${concept_id} 로 매핑을 확정했습니다.`;
      loadSheet(state.doc, state.sheet, nodeId).catch(() => {});
    } catch (e) { $('#insStatus').textContent = e.message; }
    $('#remapBtn').disabled = false;
  };
}

// ---------------------------------------------- S02 KG 노드 검색 → 소스 ----
async function search(q) {
  try {
    const res = await api(`/api/search?concept=${encodeURIComponent(q)}`);
    const c = res.concept;
    $('#kgctx').innerHTML = `선택 노드 <span class="pill pnode">${esc(c.canonical_name)}</span>
      <span class="muted">연결 위치 ${res.sources.length}개 · ${res.documents.length}개 파일 · 값 ${res.total_rows}개</span>`;
    $('#srcList').innerHTML = res.sources.length ? res.sources.map((s, i) => `
      <button data-i="${i}"><b>${esc(s.document)}</b><br>
        <span class="muted">${esc(s.sheet)} · ${esc((s.locator || '').split('!').pop())} · ${s.mapping}${s.status === 'REVIEW_REQUIRED' ? ' ⚠' : ''}</span>
      </button>`).join('') : '<div class="empty">연결된 소스 없음</div>';
    $('#srcList').querySelectorAll('button').forEach((el) => el.onclick = () => {
      $('#srcList').querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
      el.classList.add('on');
      const s = res.sources[+el.dataset.i];
      const loc = s.locator || '';
      const cut = loc.lastIndexOf('!');
      loadSheet(s.document_id, cut > 0 ? loc.slice(0, cut) : null, s.node_id)
        .then(() => openInspector(s.node_id))
        .catch((e) => $('#vstatus').textContent = e.message);
    });
  } catch (e) {
    $('#kgctx').textContent = e.message;
    $('#srcList').innerHTML = '<div class="empty">검색 결과 없음</div>';
  }
}

// ------------------------------------------- S04 통합 DB Builder + 결과 ----
function renderCart() {
  const c = cart();
  const byConcept = {};
  c.forEach((x) => { (byConcept[x.concept_id || '(미매핑)'] ||= []).push(x); });
  $('#cart').innerHTML = Object.keys(byConcept).length ? Object.entries(byConcept).map(
    ([cid, items]) => `<div class="concept"><span><b>${esc(cid)}</b>
      <div class="muted">${items.length} 위치 · ${esc(items[0].role || '')}</div></span>
      <button class="x" data-c="${esc(cid)}" title="이 개념 묶음 제거">✕</button></div>`).join('')
    : '<div class="empty">아직 담긴 위치가 없습니다</div>';
  $('#cart').querySelectorAll('.x').forEach((b) => b.onclick = () => {
    saveCart(cart().filter((x) => (x.concept_id || '(미매핑)') !== b.dataset.c));
    refreshProposal();
  });
  const docs = [...new Set(c.map((x) => x.document))];
  $('#cartDocs').innerHTML = docs.length ? docs.map((d) => `☑ ${esc(d)}`).join('<br>') : '—';
}

let proposal = null;
async function refreshProposal() {
  renderCart();
  const c = cart();
  if (!c.length) {
    $('#schemaRows').innerHTML = '<tr><td colspan="6" class="empty">묶음을 담으면 제안이 생성됩니다</td></tr>';
    proposal = null;
    return;
  }
  proposal = await api('/api/proposal', { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ node_ids: c.map((x) => x.node_id) }) });
  $('#schemaRows').innerHTML = proposal.fields.map((f, i) => `
    <tr><td><input value="${esc(f.field_name)}" data-f="${i}"
        style="border:1px solid var(--line);border-radius:6px;padding:5px;width:150px"></td>
      <td>${esc(f.concept_name)}</td>
      <td><span class="pill ${ROLE_PILL[f.role] || 'pctx'}">${esc(f.role || '')}</span></td>
      <td>${f.sources}</td><td>${esc(f.note)}</td>
      <td style="color:${f.status === '검토' ? 'var(--orange)' : 'var(--green)'}">${esc(f.status)}</td></tr>`).join('');
  $('#schemaRows').querySelectorAll('input').forEach((inp) =>
    inp.onchange = () => { proposal.fields[+inp.dataset.f].field_name = inp.value.trim(); });
}

$('#clearCart').onclick = () => { saveCart([]); refreshProposal(); };

$('#buildDb').onclick = async () => {
  if (!proposal || !proposal.fields.length) {
    $('#buildStatus').textContent = '먼저 탐색 화면에서 위치를 담으세요.';
    return;
  }
  const name = ($('#dbName').value.trim() || 'result').replace(/[^A-Za-z0-9_]/g, '_');
  $('#buildDb').disabled = true;
  $('#st4').classList.remove('on'); $('#st3').classList.add('on');
  $('#buildStatus').textContent = 'BUILDING…';
  try {
    const body = {
      name,
      fields: proposal.fields.map((f) => ({
        name: f.field_name.replace(/[^A-Za-z0-9_]/g, '_') || f.concept_id,
        concept: f.concept_id, unit: f.target_unit, type: f.type })),
      include_nodes: Object.fromEntries(proposal.fields.map((f) => [
        f.field_name.replace(/[^A-Za-z0-9_]/g, '_') || f.concept_id, f.node_ids])),
    };
    const r = await api('/api/build', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    $('#buildStatus').textContent = `✓ ${r.status}`;
    $('#st3').classList.remove('on'); $('#st4').classList.add('on');
    const cols = r.preview.length ? Object.keys(r.preview[0]).filter((k) => !k.startsWith('_')) : [];
    $('#result').style.display = '';
    $('#result').innerHTML = `
      <h3 style="margin:0 0 4px">결과 — <span style="color:var(--blue)">${esc(r.table)}</span></h3>
      <div class="muted">${r.row_count} rows · Lineage ${r.lineage.edges}셀 / ${r.lineage.documents}개 문서 ·
        artifact: <code>${esc(r.artifact)}</code></div>
      ${r.build_report.warnings.length ? `<div class="warn">⚠ Warnings: ${esc(JSON.stringify(r.build_report.warnings))}</div>` : ''}
      <h4 style="margin:12px 0 4px">Schema Manifest</h4>
      <table><thead><tr><th>필드</th><th>KG Concept</th><th>단위</th><th>타입</th></tr></thead><tbody>
        ${r.schema.map((s) => `<tr><td>${esc(s.field)}</td><td>${esc(s.concept)}</td>
          <td>${esc(s.unit || '—')}</td><td>${esc(s.type || '—')}</td></tr>`).join('')}</tbody></table>
      <h4 style="margin:12px 0 4px">Preview (5행)</h4>
      <div style="overflow-x:auto"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.preview.map((row) => `<tr>${cols.map((c) =>
          `<td>${esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  } catch (e) {
    $('#buildStatus').textContent = `실패: ${e.message}`;
  }
  $('#buildDb').disabled = false;
};

// ----------------------------------------------------------------- init ----
(async () => {
  loadFiles().catch(() => {});
  try {
    state.concepts = await api('/api/concepts');
    $('#concepts').innerHTML = state.concepts.map((c) =>
      `<option value="${esc(c.canonical_name)}">${esc(c.concept_id)} · 소스 ${c.sources}</option>`).join('');
  } catch {}
  let t = null;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    if (v) t = setTimeout(() => search(v), 250);
  };
  saveCart(cart());   // 배지/목록 초기화 (§7.2: 화면 이동 후에도 유지)
})();
