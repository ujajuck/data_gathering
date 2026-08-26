// KG 뷰어 — 단일 화면: 개념 검색/검수(좌) + 웹 xlsx 그리드(우).
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const state = { doc: null, sheet: null, seq: 0, pendingHl: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return r.json();
}

// ------------------------------------------------------------- xlsx 뷰어 ----
function colName(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(64 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function parseRange(range) {                     // "A1:B10" | "K9" → {r1,c1,r2,c2}
  const one = (a) => {
    const m = /^([A-Z]+)(\d+)$/.exec(a.trim());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { c, r: +m[2] };
  };
  const [a, b] = range.split(':');
  const p1 = one(a), p2 = one(b || a);
  if (!p1 || !p2) return null;
  return { r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c),
           r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) };
}

async function loadSheet(doc, sheet, hlRange) {
  const seq = ++state.seq;
  $('#status').textContent = '불러오는 중…';
  const data = await api(`/api/sheet?doc=${encodeURIComponent(doc)}` +
                         (sheet ? `&name=${encodeURIComponent(sheet)}` : ''));
  if (seq !== state.seq) return;                 // 뒤늦은 응답 무시
  state.doc = doc; state.sheet = data.sheet;

  $('#tabs').innerHTML = data.sheets.map((s) =>
    `<button data-s="${esc(s)}" class="${s === data.sheet ? 'on' : ''}">${esc(s)}</button>`).join('');
  $('#tabs').querySelectorAll('button').forEach((b) =>
    b.onclick = () => loadSheet(doc, b.dataset.s));

  const byPos = new Map();
  for (const c of data.cells) byPos.set(`${c.r},${c.c}`, c);
  const covered = new Set();
  for (const c of data.cells) {
    for (let r = c.r; r < c.r + c.rs; r++)
      for (let k = c.c; k < c.c + c.cs; k++)
        if (r !== c.r || k !== c.c) covered.add(`${r},${k}`);
  }
  const hl = hlRange ? parseRange(hlRange) : null;
  const inHl = (r, c) => hl && r >= hl.r1 && r <= hl.r2 && c >= hl.c1 && c <= hl.c2;

  let html = '<table class="grid"><tr><td class="hd"></td>';
  for (let c = 1; c <= data.max_col; c++) html += `<td class="hd">${colName(c)}</td>`;
  html += '</tr>';
  for (let r = 1; r <= data.max_row; r++) {
    html += `<tr><td class="hd">${r}</td>`;
    for (let c = 1; c <= data.max_col; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = byPos.get(`${r},${c}`);
      const cls = inHl(r, c) ? ' class="hl"' : '';
      if (!cell) { html += `<td${cls}></td>`; continue; }
      const style = [];
      if (cell.f) style.push(`background:${esc(cell.f)}`);
      if (cell.b) style.push('font-weight:700');
      html += `<td${cls}${cell.rs > 1 ? ` rowspan="${cell.rs}"` : ''}` +
              `${cell.cs > 1 ? ` colspan="${cell.cs}"` : ''}` +
              `${style.length ? ` style="${style.join(';')}"` : ''}` +
              ` title="${colName(c)}${r}">${esc(cell.v)}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  $('#gridwrap').innerHTML = html;
  $('#status').textContent = `${data.sheet} — ${data.max_row}×${data.max_col}` +
    (data.truncated ? ' (잘림)' : '') + (hlRange ? ` · 하이라이트 ${hlRange}` : '');
  const first = $('#gridwrap td.hl');
  if (first) first.scrollIntoView({ block: 'center', inline: 'center' });
}

function jump(documentId, locator) {
  if (!documentId || !locator) return;
  const i = locator.lastIndexOf('!');
  const sheet = i > 0 ? locator.slice(0, i) : null;
  const range = i > 0 ? locator.slice(i + 1) : locator;
  $('#docsel').value = documentId;
  loadSheet(documentId, sheet, range).catch((e) => $('#status').textContent = e.message);
}

// ---------------------------------------------------------------- 좌측 ----
async function search(q) {
  try {
    const res = await api(`/api/search?concept=${encodeURIComponent(q)}`);
    const c = res.concept;
    $('#srch2').textContent =
      `${c.canonical_name} (${c.concept_id}) — 소스 ${res.sources.length}개 · ${res.total_rows}행`;
    $('#sources').innerHTML = res.sources.length ? res.sources.map((s, i) => `
      <div class="src" data-i="${i}">
        <span><span class="h">${esc(s.header)}</span>
          <span class="m">· ${esc(s.sheet)}${s.unit ? ' · ' + esc(s.unit) : ''}</span><br>
          <span class="m">${esc(s.document)}</span></span>
        <span class="m">${s.rows}행 · ${s.mapping}${s.status === 'REVIEW_REQUIRED' ? ' ⚠' : ''}</span>
      </div>`).join('') : '<div class="empty">연결된 소스 없음</div>';
    $('#sources').querySelectorAll('.src').forEach((el) => el.onclick = () => {
      $('#sources').querySelectorAll('.src.on').forEach((x) => x.classList.remove('on'));
      el.classList.add('on');
      const s = res.sources[+el.dataset.i];
      jump(s.document_id, s.locator);
    });
  } catch (e) {
    $('#srch2').textContent = '개념을 검색하면 문서 횡단 소스가 나옵니다';
    $('#sources').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

async function loadReview() {
  const rows = await api('/api/review');
  $('#review').innerHTML = rows.length ? rows.map((r) => `
    <div class="rev" data-id="${esc(r.mapping_id)}">
      <div class="h" data-doc="${esc(r.document_id)}" data-loc="${esc(r.locator || '')}">
        ${esc(r.node_name)} → ${esc(r.concept_id || '?')} (${(+r.confidence).toFixed(2)})</div>
      <div class="m">${esc(r.filename)} · ${esc(r.reason || '')}</div>
      <button class="ok">승인</button> <button class="no">반려</button>
    </div>`).join('') : '<div class="empty">대기 항목 없음</div>';
  $('#review').querySelectorAll('.rev').forEach((el) => {
    el.querySelector('.h').onclick = (ev) =>
      jump(ev.target.dataset.doc, ev.target.dataset.loc);
    const act = (action) => async () => {
      el.querySelectorAll('button').forEach((b) => b.disabled = true);
      await api('/api/review', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping_id: el.dataset.id, action }),
      });
      loadReview();
    };
    el.querySelector('.ok').onclick = act('approve');
    el.querySelector('.no').onclick = act('reject');
  });
}

// ----------------------------------------------------------------- init ----
(async () => {
  const [docs, concepts] = await Promise.all([api('/api/documents'), api('/api/concepts')]);
  $('#docsel').innerHTML = docs.map((d) =>
    `<option value="${esc(d.document_id)}">${esc(d.filename)}</option>`).join('');
  $('#docsel').onchange = () => loadSheet($('#docsel').value, null);
  $('#concepts').innerHTML = concepts.map((c) =>
    `<option value="${esc(c.canonical_name)}">${esc(c.concept_id)} · 소스 ${c.sources}</option>`).join('');
  $('#hint').textContent = `문서 ${docs.length} · 개념 ${concepts.length}`;
  let t = null;
  $('#q').oninput = (e) => {
    clearTimeout(t);
    const v = e.target.value.trim();
    if (v) t = setTimeout(() => search(v), 250);
  };
  loadReview().catch(() => {});
  if (docs.length) loadSheet(docs[0].document_id, null).catch(() => {});
})();
