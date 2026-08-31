// Semantic Excel Integration v3 — 드릴다운: 전체 Domain KG → Document KG →
// Member Documents → Source Location(원본 렌더+Overlay) → 통합 DB.
const $ = (s) => document.querySelector(s);
const esc = (t) => String(t ?? '').replace(/[&<>"']/g,
  (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  return r.json();
}
const post = (path, body) => api(path, { method: 'POST',
  headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const PALETTE = ['#3569e8', '#7b61c9', '#3a8d6d', '#b57b1b', '#c05b8c', '#3d8ea6', '#7a7f8a'];
const ROLE_BADGE = { KEY: 'green', VALUE: 'blue', CONTEXT: 'amber', IGNORE: '' };

const state = {
  domain: null, dkgs: [], files: [],
  raw: [], rawInfo: {},   // 미등록 파일 + 분석(제안) 결과
  selNode: null,          // {id, name}
  selDkg: null,           // dkg id
  selDkgDoc: null,        // Document KG 상세에서 선택한 문서
  reviewDoc: null,        // 검수 모드 대상 문서
  doc: null, sheet: null, seq: 0,
  overlayEnabled: true,
  lastBuild: null,
};

// KG 데이터 재조회 — 편집/등록/재크롤링 후 캐시 3종을 한 번에 갱신한다
async function reloadKg() {
  [state.domain, state.dkgs, conceptsCache] = await Promise.all([
    api('/api/kg/domain'), api('/api/kg/document'), api('/api/concepts')]);
  if (state.selDkg && !state.dkgs.some((g) => g.id === state.selDkg)) state.selDkg = null;
  state.dkgDetail = null;
  state.nodeSearch = null;
  renderDomainGraph();
  renderNav($('#kgSearch').value.trim());
}

function pollRecrawl(runId, onUpdate) {
  let fails = 0;
  const tick = () => api(`/api/recrawl/${encodeURIComponent(runId)}`)
    .then((r) => {
      fails = 0;
      onUpdate(r);
      if (r.status === 'RUNNING') setTimeout(tick, 2000);
    })
    .catch(() => {
      // 일시 오류로 체인이 조용히 끊기지 않게 — 연속 5회 실패 시 중단 통보
      if (++fails <= 5) setTimeout(tick, 3000);
      else onUpdate({ status: 'POLL_LOST', summary: [] });
    });
  tick();
}

// -------------------------------------------------- 통합 초안 (Selection Basket)
const CART_KEY = 'kg_cart_v3';
function cart() { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; } }
function saveCart(c) {
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch {}
  $('#cartN').textContent = c.length ? `(${c.length})` : '';
}
function addToCart(items) {
  const c = cart();
  for (const it of [].concat(items))
    if (!c.some((x) => x.node_id === it.node_id)) c.push(it);
  saveCart(c);
}

// ---------------------------------------------------------------- 탭 전환
const steps = [...document.querySelectorAll('.step')];
function show(id) {
  steps.forEach((b) => b.classList.toggle('active', b.dataset.screen === id));
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  if (id === 'source') renderSourceScreen();
  if (id === 'db') refreshProposal();
  if (id === 'files') { loadFiles().catch(() => {}); loadRawFiles().catch(() => {}); }
}
steps.forEach((b) => b.onclick = () => show(b.dataset.screen));

const dkgOf = (id) => state.dkgs.find((g) => g.id === id);
const dkgColor = (id) => PALETTE[state.dkgs.findIndex((g) => g.id === id) % PALETTE.length];

// ================================================================ 1. 파일 분석
const FBADGE = { READY: ['green', 'Ready'], REVIEW_REQUIRED: ['amber', '검토 필요'],
                 ERROR: ['red', 'Error'] };
async function loadFiles() {
  state.files = await api('/api/files');
  $('#fileRows').innerHTML = state.files.map((f) => {
    const [cls, label] = FBADGE[f.status] || ['', f.status];
    const dkgs = state.dkgs.filter((g) => (g.member_document_ids || []).includes(f.document_id));
    return `<tr><td><b>${esc(f.filename)}</b></td>
      <td>${dkgs.map((g) => `<span class="badge" style="border-color:${dkgColor(g.id)};color:${dkgColor(g.id)}">${esc(g.name)}</span>`).join(' ') || '—'}</td>
      <td>${f.headers}</td><td>${f.coverage_pct}%</td>
      <td>${f.review ? `<button class="secondary" data-review="${esc(f.document_id)}">${f.review}건 검수</button>` : '—'}</td>
      <td><span class="badge ${f.drm_status === 'READY' ? 'green' : 'amber'}">${esc(f.drm_status || 'PROTECTED')}</span>
        ${f.render_status ? `<span class="badge ${f.render_status === 'SUCCESS' ? 'green' : (f.render_status === 'FAILED' ? 'red' : '')}">Render ${esc(f.render_status)}</span>` : ''}
        ${f.parsing_status ? `<span class="badge blue">Parse ${esc(f.parsing_status)}</span>` : ''}</td>
      <td><span class="badge ${cls}">${esc(label)}</span></td>
      <td><button class="secondary" data-open="${esc(f.document_id)}">열어보기</button></td></tr>`;
  }).join('') || '<tr><td colspan="8" class="empty">등록된 파일이 없습니다 — kg ingest를 먼저 실행하세요</td></tr>';
  $('#fileRows').querySelectorAll('[data-open]').forEach((b) => b.onclick = () => {
    state.reviewDoc = null;
    show('source');
    loadSheet(b.dataset.open, null).catch((e) => setVStatus(e.message));
  });
  $('#fileRows').querySelectorAll('[data-review]').forEach((b) => b.onclick = () => {
    state.reviewDoc = b.dataset.review;   // §3.2 검토 큐 → 순차 검수
    state.selNode = null;
    show('source');
  });
}

// ---- 미등록 파일: 분석(map=false) → 같은 형식 DKG 제안 → 배정 등록 (KG2)
//      잠긴 파일(암호화/DRM)은 우회 없이 정식 해제 요청 → 해제본 도착 감지.
async function loadRawFiles() {
  try { state.raw = await api('/api/raw-files'); } catch { state.raw = []; }
  // '분석'으로 구조만 적재된 파일은 서버 목록에서 빠지므로 rawInfo 쪽을 합친다
  const names = [...new Set([...state.raw.map((f) => f.filename),
                             ...Object.keys(state.rawInfo)])].sort();
  const byName = Object.fromEntries(state.raw.map((f) => [f.filename, f]));
  state.drmText = state.drmText || {};
  state.rawBusy = state.rawBusy || {};      // 분석/등록 진행 중 재클릭 방지
  // 전체 재렌더로 다른 행의 사유 입력값이 날아가지 않게 보존한다
  const savedNotes = {};
  $('#rawRows').querySelectorAll('[data-notein]').forEach((i) => {
    if (i.value) savedNotes[i.dataset.notein] = i.value;
  });
  $('#rawPanel').style.display = names.length ? '' : 'none';
  $('#rawRows').innerHTML = names.map((fn) => {
    const f = byName[fn] || {};
    const info = state.rawInfo[fn];
    let badge = '';
    let inner;
    if (f.locked) {
      const drm = f.drm;
      if (drm && drm.status === 'REQUESTED') {
        badge = ` <span class="badge amber">해제 요청됨 · ${esc((drm.requested_at || '').slice(0, 10))}</span>`;
        inner = `<div class="sub" style="font-size:11px;margin-top:4px">
            ${esc(f.container_detail || '')} — 해제본이 data/raw에 같은 파일명으로
            도착하면 자동 감지되어 등록 가능해집니다.</div>
          <button class="secondary" style="margin-top:6px" data-drmtext="${esc(fn)}"
            data-note="${esc(drm.note || '')}">요청서 재발급·복사</button>`;
      } else {
        badge = ' <span class="badge red">🔒 잠김 (암호화/DRM)</span>';
        inner = `<div class="sub" style="font-size:11px;margin-top:4px">
            ${esc(f.container_detail || '')} — 파싱·뷰어 모두 불가.
            정식 해제 요청서를 만들어 결재/그룹웨어에 첨부하세요.</div>
          <div style="display:flex;gap:6px;margin-top:6px" class="editForm">
            <input data-notein="${esc(fn)}" placeholder="요청 사유 (선택)" style="flex:1;margin-top:0">
            <button class="primary" data-drmreq="${esc(fn)}">정식 해제 요청</button></div>`;
      }
      if (state.drmText[fn]) {
        inner += `<pre style="margin-top:7px;padding:9px;border:1px solid var(--line);
            border-radius:8px;font-size:11px;white-space:pre-wrap;background:#fff"
            data-pre="${esc(fn)}">${esc(state.drmText[fn])}</pre>
          <button class="secondary" data-copy="${esc(fn)}">요청서 복사</button>
          <button class="secondary" data-closepre="${esc(fn)}">닫기</button>`;
      }
    } else if (info) {
      const chips = [
        ...(info.suggestions || []).map((s) =>
          `<span class="chip pick${info.picked === s.root_concept_id ? ' sel' : ''}"
            data-fn="${esc(fn)}" data-g="${esc(s.root_concept_id)}">${esc(s.name)}
            · ${s.match_pct}%${s.has_recipe ? ' · 레시피' : ''}</span>`),
        `<span class="chip pick${info.picked === '' ? ' sel' : ''}"
          data-fn="${esc(fn)}" data-g="">새 형식 (자동 판정)</span>`].join('');
      inner = `<div style="margin-top:6px;font-size:12px">${(info.suggestions || []).length
        ? '같은 형식으로 보이는 Document KG — 선택하면 레시피로 매핑을 이식합니다:'
        : '비슷한 형식의 Document KG가 없습니다.'}<br>${chips}</div>
        <button class="primary" style="margin-top:7px" data-reg="${esc(fn)}"
          ${state.rawBusy[fn] ? 'disabled' : ''}>
          ${info.picked ? '선택한 DKG로 등록' : '등록 (자동 판정)'}</button>`;
    } else {
      if (f.drm && f.drm.status === 'RELEASED')
        badge = ' <span class="badge green">✓ 해제본 도착 — 등록 가능</span>';
      inner = `<div><button class="secondary" style="margin-top:5px"
        data-an="${esc(fn)}" ${state.rawBusy[fn] ? 'disabled' : ''}>분석 · DKG 제안</button></div>`;
    }
    return `<div class="fileRow" style="cursor:default"><b>${esc(fn)}</b>${badge}${inner}
      <div class="status" data-st="${esc(fn)}"></div></div>`;
  }).join('');
  Object.entries(savedNotes).forEach(([fn, v]) => {   // 사유 입력값 복원
    const i = $('#rawRows').querySelector(`[data-notein="${CSS.escape(fn)}"]`);
    if (i) i.value = v;
  });
  // DRM 요청/재발급/복사
  const drmPost = async (fn, note) => {
    const r = await post('/api/drm/request', { filename: fn, note });
    state.drmText[fn] = r.request_text;
    await loadRawFiles();
  };
  $('#rawRows').querySelectorAll('[data-drmreq]').forEach((b) => b.onclick = async () => {
    const fn = b.dataset.drmreq;
    const noteEl = $('#rawRows').querySelector(`[data-notein="${CSS.escape(fn)}"]`);
    b.disabled = true;
    try { await drmPost(fn, noteEl ? noteEl.value.trim() : ''); }
    catch (e) {
      const st0 = $('#rawRows').querySelector(`[data-st="${CSS.escape(fn)}"]`);
      if (st0) st0.textContent = e.message;
      b.disabled = false;
    }
  });
  $('#rawRows').querySelectorAll('[data-drmtext]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await drmPost(b.dataset.drmtext, b.dataset.note || ''); }
    catch (e) {
      const st1 = $('#rawRows').querySelector(
        `[data-st="${CSS.escape(b.dataset.drmtext)}"]`);
      if (st1) st1.textContent = `재발급 실패: ${e.message}`;
      b.disabled = false;
    }
  });
  $('#rawRows').querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => {
    try {
      await navigator.clipboard.writeText(state.drmText[b.dataset.copy] || '');
      b.textContent = '✓ 복사됨';
    } catch {
      const pre = $('#rawRows').querySelector(`[data-pre="${CSS.escape(b.dataset.copy)}"]`);
      if (pre) { const r = document.createRange(); r.selectNodeContents(pre);
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      b.textContent = '선택됨 — Ctrl+C';
    }
  });
  $('#rawRows').querySelectorAll('[data-closepre]').forEach((b) => b.onclick = () => {
    delete state.drmText[b.dataset.closepre];
    loadRawFiles();
  });
  const st = (fn) => $('#rawRows').querySelector(`[data-st="${CSS.escape(fn)}"]`);
  $('#rawRows').querySelectorAll('[data-an]').forEach((b) => b.onclick = async () => {
    const fn = b.dataset.an;
    if (state.rawBusy[fn]) return;
    state.rawBusy[fn] = true;              // 재렌더돼도 disabled 유지 (중복 분석 방지)
    b.disabled = true;
    st(fn).textContent = '구조 분석 중…';
    try {
      const r = await post('/api/ingest', { filename: fn, map: false });
      const sugg = r.suggestions || [];
      state.rawInfo[fn] = {
        document_id: r.document_id, suggestions: sugg,
        picked: sugg.length ? sugg[0].root_concept_id : '' };
      delete state.rawBusy[fn];
      loadRawFiles();
    } catch (e) {
      delete state.rawBusy[fn];
      st(fn).textContent = e.message;
      b.disabled = false;
    }
  });
  $('#rawRows').querySelectorAll('.chip.pick').forEach((c) => c.onclick = () => {
    state.rawInfo[c.dataset.fn].picked = c.dataset.g;
    loadRawFiles();
  });
  $('#rawRows').querySelectorAll('[data-reg]').forEach((b) => b.onclick = async () => {
    const fn = b.dataset.reg;
    const info = state.rawInfo[fn];
    if (state.rawBusy[fn]) return;
    state.rawBusy[fn] = true;
    b.disabled = true;
    st(fn).textContent = '등록 중… (레시피 적용 + 자동 판정)';
    try {
      const body = { filename: fn };
      if (info && info.picked) body.group_id = info.picked;
      const r = await post('/api/ingest', body);
      const rc = r.recipe;
      const parts = [];
      if (r.ingest && r.ingest.unchanged !== undefined)
        parts.push(`승계 ${r.ingest.unchanged}`);
      if (rc) parts.push(`레시피 이식 ${rc.applied}건` +
        (rc.review ? ` (검토 ${rc.review})` : '') +
        (rc.relaxed ? ' · 양식 변경 감지' : ''));
      if (r.map) parts.push(`자동 판정 ${r.map.nodes}건` +
        (r.map.REVIEW_REQUIRED ? ` (검토 ${r.map.REVIEW_REQUIRED})` : ''));
      st(fn).textContent = `✓ 등록 완료 — ${parts.join(' · ') || '변경 없음'}`;
      delete state.rawInfo[fn];
      delete state.rawBusy[fn];
      await reloadKg();          // 파일 표의 DKG 배지가 최신 그룹으로 그려지도록
      await loadFiles();         // dkgs 갱신 이후에 렌더 (순서 중요)
      setTimeout(() => loadRawFiles().catch(() => {}), 2500);  // 토스트 읽을 시간
    } catch (e) {
      delete state.rawBusy[fn];
      st(fn).textContent = `실패: ${e.message}`;
      b.disabled = false;
    }
  });
}

// ================================================================ 2. KG 탐색
// ---- 전체 Domain KG: 루트 → L1 → 리프로 내려가는 노드-링크 트리 위에
//      Document KG Coverage Hull을 겹쳐 그린다 (§3.2 — 고정 좌표 유지)
function layoutDomain() {
  const leafs = state.domain.nodes.filter((n) => n.level !== 'L1');
  const l1s = Object.fromEntries(
    state.domain.nodes.filter((n) => n.level === 'L1').map((n) => [n.id, n]));
  const groups = [];
  const order = [...state.dkgs.map((g) => g.id),
    ...Object.keys(l1s).filter((id) => !state.dkgs.some((g) => g.id === id))];
  for (const rootId of order) {
    const nodes = leafs.filter((n) => n.root === rootId);
    if (!nodes.length) continue;
    // 부모(L2) 바로 뒤에 자식(L3)이 오도록 정렬 — 계층 엣지가 이웃 칸으로 떨어진다
    const l2 = nodes.filter((n) => l1s[n.parent])
      .sort((a, b) => b.sources - a.sources || a.name.localeCompare(b.name));
    const ordered = [];
    for (const p of l2) {
      ordered.push(p);
      ordered.push(...nodes.filter((n) => n.parent === p.id));
    }
    for (const n of nodes) if (!ordered.includes(n)) ordered.push(n);
    const dkg = dkgOf(rootId) ||
      { id: rootId, name: (l1s[rootId] ? l1s[rootId].name : rootId) + ' KG',
        member_document_count: 0 };
    groups.push({ dkg, l1: l1s[rootId], nodes: ordered });
  }
  const NW = 104, NH = 30, GX = 12, GY = 26, PAD = 16, L1H = 34, LABEL = 26;
  const ROOTH = 42;
  let x = 14, y = 96, rowH = 0;
  const MAXW = 1160;
  for (const g of groups) {
    const cols = Math.min(4, Math.max(2, Math.ceil(g.nodes.length / 3)));
    const rows = Math.ceil(g.nodes.length / cols);
    g.w = cols * (NW + GX) - GX + PAD * 2;
    g.h = PAD + L1H + 18 + rows * (NH + GY) - GY + LABEL + PAD;
    if (x + g.w > MAXW) { x = 14; y += rowH + 26; rowH = 0; }
    g.x = x; g.y = y;
    x += g.w + 20; rowH = Math.max(rowH, g.h);
    g.l1x = g.x + g.w / 2;                 // L1 노드 중심
    g.l1y = g.y + PAD;
    g.nodes.forEach((n, i) => {
      n.x = g.x + PAD + (i % cols) * (NW + GX);
      n.y = g.y + PAD + L1H + 18 + Math.floor(i / cols) * (NH + GY);
    });
  }
  const height = y + rowH + 20;
  return { groups, height, NW, NH, L1H, ROOTH };
}

function renderDomainGraph() {
  const { groups, height, NW, NH, L1H } = layoutDomain();
  const rootX = 590, rootY = 16, ROOTW = 150, ROOTH = 40;
  const nodeAt = {};
  const hulls = [], edges = [], boxes = [];
  for (const g of groups) for (const n of g.nodes) nodeAt[n.id] = n;

  for (const g of groups) {
    const color = dkgColor(g.dkg.id);
    const dim = (state.selDkg && state.selDkg !== g.dkg.id) ? ' dim' : '';
    // Coverage Hull — 트리 가지(L1+리프)를 감싸는 반투명 영역, 라벨은 하단
    hulls.push(`<rect class="hull${dim}" data-dkg="${esc(g.dkg.id)}" x="${g.x}" y="${g.y}"
      width="${g.w}" height="${g.h}" rx="22" style="fill:${color}10;stroke:${color}"/>
      <text class="hlabel${dim}" data-dkg="${esc(g.dkg.id)}" x="${g.x + 14}"
        y="${g.y + g.h - 12}" style="fill:${color}">${esc(g.dkg.name)} · ${g.dkg.member_document_count} docs</text>`);
    // 루트 → L1 엣지
    edges.push(`<path class="gedge" d="M${rootX + ROOTW / 2} ${rootY + ROOTH}
      C ${rootX + ROOTW / 2} ${rootY + ROOTH + 26}, ${g.l1x} ${g.l1y - 26}, ${g.l1x} ${g.l1y}"/>`);
    // L1 → 각 리프 팬아웃 (L3는 자기 부모 L2에 연결)
    for (const n of g.nodes) {
      const p = nodeAt[n.parent];
      const fromX = p ? p.x + NW / 2 : g.l1x;
      const fromY = p ? p.y + NH : g.l1y + L1H;
      edges.push(`<line class="gedge" x1="${fromX}" y1="${fromY}"
        x2="${n.x + NW / 2}" y2="${n.y}"/>`);
    }
    // L1 노드
    const l1sel = state.selDkg === g.dkg.id ? ' sel' : '';
    boxes.push(`<g><rect class="gnode${l1sel}${dim}" data-dkg="${esc(g.dkg.id)}"
      x="${g.l1x - 62}" y="${g.l1y}" width="124" height="${L1H}" rx="11"
      style="stroke:${color};fill:#fff"/>
      <text class="ntext" x="${g.l1x}" y="${g.l1y + L1H / 2 + 1}"
        style="fill:${color}">${esc(g.l1 ? g.l1.name : g.dkg.name)}</text></g>`);
    // 리프 노드
    for (const n of g.nodes) {
      const sel = state.selNode && state.selNode.id === n.id ? ' sel' : '';
      boxes.push(`<g><rect class="gnode${sel}${dim}" data-node="${esc(n.id)}" x="${n.x}" y="${n.y}"
        width="${NW}" height="${NH}" rx="9"/>
        <text class="ntext" x="${n.x + NW / 2}" y="${n.y + 12}">${esc(n.name)}</text>
        <text class="ncnt" x="${n.x + NW / 2}" y="${n.y + 24}">${n.sources ? n.sources + ' src' : '미연결'}</text></g>`);
    }
  }
  const root = `<g><rect class="gnode" x="${rootX}" y="${rootY}" width="${ROOTW}" height="${ROOTH}"
      rx="13" style="stroke:#8d99ad;stroke-width:2"/>
    <text class="ntext" x="${rootX + ROOTW / 2}" y="${rootY + ROOTH / 2 - 5}">${esc(state.domain.domain || 'Domain')}</text>
    <text class="ncnt" x="${rootX + ROOTW / 2}" y="${rootY + ROOTH / 2 + 11}">Fixed Domain KG</text></g>`;
  $('#domainGraph').innerHTML =
    `<svg class="graphSvg" viewBox="0 0 1180 ${height}" style="height:${Math.min(660, height)}px"
      aria-label="전체 Domain KG 트리와 Document KG 커버리지">
      ${hulls.join('')}${edges.join('')}${root}${boxes.join('')}</svg>`;
  $('#domainGraph').querySelectorAll('[data-node]').forEach((el) =>
    el.onclick = () => selectNode(el.dataset.node));
  $('#domainGraph').querySelectorAll('[data-dkg]').forEach((el) =>
    el.onclick = () => selectDkg(el.dataset.dkg));
}

// ---- Document KG 상세: 커버 노드 + Member Documents (§4)
async function renderDocGraph(dkgId) {
  const g = await api(`/api/kg/document/${encodeURIComponent(dkgId)}`);
  state.dkgDetail = g;
  const color = dkgColor(dkgId);
  const nameOf = Object.fromEntries(state.domain.nodes.map((n) => [n.id, n.name]));
  const top = g.domain_node_ids.slice(0, 6);
  const NODEW = 128, W = 1180;
  const nx = (i) => 70 + i * (NODEW + 40);
  const docs = g.member_documents.slice(0, 4);
  const dx = (i) => 60 + i * 280;
  const parts = [];
  parts.push(`<rect x="40" y="55" width="${Math.max(nx(top.length - 1) + NODEW + 30 - 40, 460)}"
    height="130" rx="20" class="hull" style="fill:${color}10;stroke:${color}"/>`);
  parts.push(`<text x="58" y="84" font-size="15" font-weight="800" fill="${color}">${esc(g.name)}</text>`);
  // 엣지: 문서 → 제공 노드
  docs.forEach((d, di) => {
    top.forEach((nid, ni) => {
      if (d.nodes.includes(nameOf[nid])) {
        const hi = state.selDkgDoc === d.document_id ? ' hi' : '';
        parts.push(`<line class="docEdge${hi}" x1="${nx(ni) + NODEW / 2}" y1="150"
          x2="${dx(di) + 110}" y2="330"/>`);
      }
    });
  });
  top.forEach((nid, i) => {
    parts.push(`<g><rect class="docNode" x="${nx(i)}" y="105" width="${NODEW}" height="45" rx="10"/>
      <text class="ntext" x="${nx(i) + NODEW / 2}" y="127">${esc(nameOf[nid] || nid)}</text></g>`);
  });
  if (g.domain_node_ids.length > top.length)
    parts.push(`<text x="${nx(top.length - 1) + NODEW + 44}" y="132" font-size="12" fill="#6e7685">외 ${g.domain_node_ids.length - top.length}개 노드</text>`);
  parts.push(`<text x="60" y="300" font-size="12" fill="#6e7685" font-weight="700">MEMBER DOCUMENTS</text>`);
  docs.forEach((d, i) => {
    const sel = state.selDkgDoc === d.document_id ? ' sel' : '';
    parts.push(`<g><rect class="docFile${sel}" data-doc="${esc(d.document_id)}" x="${dx(i)}" y="330"
      width="230" height="92" rx="11"/>
      <text x="${dx(i) + 14}" y="355" font-size="12" font-weight="700">${esc(d.filename.slice(0, 24))}${d.filename.length > 24 ? '…' : ''}</text>
      <text x="${dx(i) + 14}" y="376" font-size="11" fill="#6e7685">${esc((d.first_locator || '').slice(0, 30))}</text>
      <text x="${dx(i) + 14}" y="396" font-size="11" fill="#6e7685">mapped: ${esc(d.nodes.slice(0, 3).join(', ').slice(0, 30))}${d.nodes.length > 3 ? '…' : ''}</text>
      <text x="${dx(i) + 14}" y="414" font-size="11" fill="#6e7685">${d.sources} source</text></g>`);
  });
  if (g.member_documents.length > docs.length || g.member_document_count > docs.length)
    parts.push(`<text x="60" y="470" font-size="12" fill="#6e7685">… 외 ${g.member_document_count - docs.length}개 문서 (우측 목록에서 선택)</text>`);
  $('#docGraph').innerHTML =
    `<svg class="graphSvg" viewBox="0 0 ${W} 500" style="height:520px"
      aria-label="Document KG와 소속 문서">${parts.join('')}</svg>`;
  $('#docGraph').querySelectorAll('[data-doc]').forEach((el) =>
    el.onclick = () => { state.selDkgDoc = el.dataset.doc; renderDocGraph(dkgId); renderDkgDetail(); });
}

function graphMode(docMode) {
  $('#domainGraph').style.display = docMode ? 'none' : '';
  $('#docGraph').style.display = docMode ? '' : 'none';
  $('#showDomainGraph').classList.toggle('active', !docMode);
  $('#showDocGraph').classList.toggle('active', docMode);
  const g = state.selDkg ? dkgOf(state.selDkg) : null;
  $('#graphTitle').textContent = docMode
    ? 'Document KG에 어떤 문서가 속하는지 보기' : '전체 KG에서 Document KG 위치 보기';
  $('#graphSub').textContent = docMode
    ? '선택한 Document KG의 Domain Node와 그 노드에 데이터를 제공하는 문서를 함께 봅니다.'
    : '반투명 영역은 각 Document KG(문서군)가 Domain KG의 어느 노드들을 커버하는지 나타냅니다.';
  $('#crumb').innerHTML = docMode && g
    ? `<b>전체 Domain KG</b> › ${esc(g.name)}`
    : `<b>전체 Domain KG</b> · Document KG Coverage`;
  if (docMode && state.selDkg) renderDocGraph(state.selDkg).catch(() => {});
}

// ---- 좌측 내비 + 우측 상세
function renderNav(filter = '') {
  const leafs = state.domain.nodes.filter((n) => n.level !== 'L1')
    .filter((n) => !filter || n.name.includes(filter) || n.id.includes(filter))
    .sort((a, b) => b.sources - a.sources);
  $('#domainList').innerHTML = leafs.map((n) =>
    `<button class="listBtn${state.selNode && state.selNode.id === n.id ? ' sel' : ''}"
      data-node="${esc(n.id)}"><span>${esc(n.name)}</span><span class="n">${n.sources}</span></button>`).join('');
  $('#domainList').querySelectorAll('[data-node]').forEach((el) =>
    el.onclick = () => selectNode(el.dataset.node));
  $('#docList').innerHTML = state.dkgs
    .filter((g) => !filter || g.name.includes(filter))
    .map((g) => `<div class="dkgCard${state.selDkg === g.id ? ' sel' : ''}" data-dkg="${esc(g.id)}">
      <b style="color:${dkgColor(g.id)}">${esc(g.name)}</b>
      <div>${g.member_document_count}개 문서 · ${g.domain_node_ids.length}개 노드 · ${g.source_location_count} 위치</div></div>`).join('');
  $('#docList').querySelectorAll('[data-dkg]').forEach((el) =>
    el.onclick = () => { selectDkg(el.dataset.dkg); graphMode(true); });
  $('#legend').innerHTML = state.dkgs.map((g) =>
    `<div><span style="display:inline-block;width:10px;height:10px;border-radius:50%;
      background:${dkgColor(g.id)};margin-right:7px"></span>${esc(g.name)} · ${g.member_document_count} docs</div>`).join('');
}

async function selectNode(nodeId) {
  const n = state.domain.nodes.find((x) => x.id === nodeId);
  if (!n) return;
  state.selNode = { id: n.id, name: n.name, root: n.root };
  state.selDkg = n.root;
  graphMode(false);
  renderDomainGraph();
  renderNav($('#kgSearch').value.trim());
  let res = null;
  try { res = await api(`/api/search?concept=${encodeURIComponent(n.id)}`); } catch {}
  state.nodeSearch = res;
  const g = n.root ? dkgOf(n.root) : null;
  const inCart = cart().some((x) => x.concept_id === n.id);
  $('#kgDetail').innerHTML = `
    <div class="kicker">SELECTED DOMAIN NODE</div><div class="title">${esc(n.name)}</div>
    <div class="sub">${esc((res && res.concept.description) || '')}</div>
    ${inCart ? '<span class="badge blue" style="margin-top:8px">✓ 통합 대상 포함됨</span>' : ''}
    <div class="metricGrid">
      <div class="metric"><span>Document KG</span><b>${g ? 1 : 0}</b></div>
      <div class="metric"><span>소속 문서</span><b>${res ? res.documents.length : 0}</b></div>
      <div class="metric"><span>데이터 위치</span><b>${res ? res.sources.length : 0}</b></div>
      <div class="metric"><span>값</span><b>${res ? res.total_rows : 0}</b></div></div>
    ${g ? `<div style="margin-top:14px" class="kicker">CONNECTED DOCUMENT KG</div>
      <div class="dkgCard" data-godkg="${esc(g.id)}"><b style="color:${dkgColor(g.id)}">${esc(g.name)}</b>
        <div>${g.member_document_count}문서 · ${g.domain_node_ids.slice(0, 4).map((i) =>
          esc((state.domain.nodes.find((x) => x.id === i) || {}).name || i)).join(' / ')}</div></div>` : ''}
    <div class="rightBtns">
      <button class="primary" id="openDocKg">Document KG 상세 보기</button>
      <button class="secondary" id="openSource">이 노드의 원본 데이터 보기</button>
      <button class="secondary" id="addNodeCart">통합 DB 대상에 추가</button>
      <button class="secondary" id="editConceptBtn">개념 편집</button></div>
    <div class="status" id="kgStatus"></div>`;
  $('#editConceptBtn').onclick = () => openConceptEditor(n.id);
  $('#openDocKg').onclick = () => { graphMode(true); renderDkgDetail(); };
  $('#openSource').onclick = () => { state.reviewDoc = null; show('source'); };
  $('#addNodeCart').onclick = () => {
    if (!res) return;
    addToCart(res.sources.filter((s) => s.status !== 'REVIEW_REQUIRED').map((s) => ({
      node_id: s.node_id, concept_id: n.id, header: s.header,
      document: s.document, sheet: s.sheet,
      range: (s.locator || '').split('!').pop(), role: null })));
    $('#kgStatus').textContent = `✓ ${res.sources.length}개 위치를 통합 대상에 담았습니다.`;
    selectNode(nodeId);
  };
}

async function selectDkg(dkgId, keepDoc) {
  state.selDkg = dkgId;
  if (!keepDoc) state.selDkgDoc = null;
  renderDomainGraph();
  renderNav($('#kgSearch').value.trim());
  const seq = (state.dkgSeq = (state.dkgSeq || 0) + 1);   // 연타 경쟁 가드
  try {   // 상세(오버라이드/레시피/최근 재크롤링 포함) 선조회
    const d = await api(`/api/kg/document/${encodeURIComponent(dkgId)}`);
    if (seq !== state.dkgSeq) return;
    state.dkgDetail = d;
    state.dkgFetchFailed = null;
  } catch {
    if (seq !== state.dkgSeq) return;
    state.dkgDetail = null;
    state.dkgFetchFailed = dkgId;
  }
  renderDkgDetail();
}

function renderDkgDetail() {
  const cur = state.selDkg;
  if (!cur) return;
  // 목록 요약(멤버 4개 잘림·오버라이드 없음)으로는 그리지 않는다 — 잘린
  // 멤버가 '문서 추가' 후보로 오염되는 결함의 수정. 상세가 없으면 조회한다.
  const g = state.dkgDetail && state.dkgDetail.id === cur ? state.dkgDetail : null;
  if (!g) {
    if (state.dkgFetchFailed === cur) {
      $('#kgDetail').innerHTML =
        '<div class="empty">Document KG 상세를 불러오지 못했습니다</div>';
      return;
    }
    $('#kgDetail').innerHTML = '<div class="empty">불러오는 중…</div>';
    selectDkg(cur, true);
    return;
  }
  const selDoc = (g.member_documents || []).find((d) => d.document_id === state.selDkgDoc);
  const rec = g.recipe;
  const memberIds = new Set((g.member_documents || []).map((d) => d.document_id));
  const addable = state.files.filter((f) => !memberIds.has(f.document_id));
  $('#kgDetail').innerHTML = `
    <div class="kicker">SELECTED DOCUMENT KG</div>
    <div class="title" style="color:${dkgColor(g.id)}">${esc(g.name)}</div>
    <div class="sub">이 문서군이 커버하는 Domain Node와 소속 문서입니다.</div>
    <div class="metricGrid">
      <div class="metric"><span>소속 문서</span><b>${g.member_document_count}</b></div>
      <div class="metric"><span>Domain Node</span><b>${g.domain_node_ids.length}</b></div>
      <div class="metric"><span>Source 위치</span><b>${g.source_location_count}</b></div>
      <div class="metric"><span>값</span><b>${g.value_count.toLocaleString()}</b></div></div>
    <div style="margin-top:13px" class="kicker">MEMBER DOCUMENTS</div>
    <div style="max-height:24vh;overflow-y:auto">
    ${(g.member_documents || []).map((d) => `
      <div class="fileRow${state.selDkgDoc === d.document_id ? ' sel' : ''}" data-doc="${esc(d.document_id)}">
        <b>${esc(d.filename)}</b>${d.override === 'INCLUDED' ? ' <span class="badge blue">고정</span>' : ''}
        <div>${esc(d.nodes.slice(0, 4).join(' · ')) || '(매핑 없음)'} · ${d.sources} src
          <button class="x" data-ex="${esc(d.document_id)}" title="이 그룹에서 제외 (매핑/빌드 소스는 유지)"
            style="border:0;background:none;color:var(--red);cursor:pointer">제외</button></div>
      </div>`).join('')}
    </div>
    ${addable.length ? `<div style="display:flex;gap:6px;margin-top:7px" class="editForm">
      <select id="dkgAddDoc" style="flex:1;margin-top:0">
        <option value="">문서 추가 (그룹에 고정)…</option>
        ${addable.map((f) => `<option value="${esc(f.document_id)}">${esc(f.filename)}</option>`).join('')}
      </select></div>` : ''}
    <div class="sub" style="font-size:11px;margin-top:4px">제외/추가는 그룹 소속만 바꿉니다 — 매핑과 빌드 소스는 유지됩니다.</div>

    <div style="margin-top:13px" class="kicker">PARSING TEMPLATES</div>
    ${(g.parsing_templates || []).length ? (g.parsing_templates || []).map((t) => `
      <div class="dkgCard" style="cursor:default;border-left:4px solid var(--purple)">
        <b style="color:var(--purple)">▣ ${esc(t.template_name)} <span class="badge blue">v${t.version}</span></b>
        <div>${t.documents.length}개 문서 · Override 문서 ${t.override_documents} · 검토 ${t.review_required} · 실패 ${t.failed}</div>
        <div style="margin-top:6px">${t.documents.map((d) => `
          <span class="chip" title="${esc(d.status)}">▤ ${esc(d.filename)}
            ${d.override_count ? `<b style="color:var(--amber)">override ${d.override_count}</b>` : ''}
            ${d.status === 'REVIEW_REQUIRED' ? '<b style="color:var(--amber)">검토 필요</b>' : ''}</span>`).join('')}</div>
      </div>`).join('')
      : '<div class="sub" style="font-size:12px">배정된 Parsing Template이 없습니다. Document는 기존 KG/레시피 흐름으로 유지됩니다.</div>'}
    <div class="sub" style="font-size:11px">▣ Parsing Template은 KG 개념 노드가 아닌 Document 파싱 운영 계층입니다.</div>

    <div style="margin-top:13px" class="kicker">EXTRACTION RECIPE</div>
    ${rec ? `<div style="font-size:12px">템플릿 ${rec.template}건
        ${rec.conflicts ? ` · <span style="color:var(--amber)">충돌 ${rec.conflicts}</span>` : ''}
        ${rec.dropped ? ` · 동률 제외 ${rec.dropped}` : ''}
        ${rec.stale_entries ? ` · <span style="color:var(--red)">소멸 개념 ${rec.stale_entries}</span>` : ''}
        <div class="sub" style="font-size:11px">${esc(rec.recipe_id)} · ${esc(rec.created_at.slice(0, 16))}</div></div>`
      : '<div class="sub" style="font-size:12px">저장된 레시피가 없습니다 — 승인된 매핑에서 스냅샷을 만들면 같은 형식의 새 문서에 매핑이 이식됩니다.</div>'}
    <div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap">
      <button class="secondary" id="dkgSnapshot">${rec ? '레시피 재저장' : '레시피 저장'}</button>
      ${rec ? '<button class="secondary" id="dkgHistory">이력</button>' : ''}
    </div>
    <div id="dkgHistBox"></div>

    <div style="margin-top:13px" class="kicker">RECRAWL</div>
    <div class="editForm" style="display:flex;gap:6px;align-items:center">
      <select id="dkgMode" style="flex:1;margin-top:0">
        <option value="fill">증분 (fill) — 미매핑만 재평가</option>
        <option value="reset_auto">자동매핑 초기화 (reset_auto)</option></select>
      <button class="primary" id="dkgRecrawl">재크롤링</button></div>
    <div class="sub" style="font-size:11px;margin-top:4px">사람 승인/거절은 보존됩니다.
      reset_auto는 검수 대기 항목도 재판정합니다.</div>
    ${g.last_recrawl ? `<div class="sub" style="font-size:11px">최근:
      ${esc(g.last_recrawl.mode)} · ${esc(g.last_recrawl.status)} · ${esc((g.last_recrawl.started_at || '').slice(0, 16))}</div>` : ''}
    <div id="recrawlProg"></div>

    <div class="rightBtns">
      <button class="primary" id="docToSource" ${selDoc ? '' : 'disabled'}>선택 문서의 원본 위치 보기</button>
      <button class="secondary" id="backDomain">전체 KG로 돌아가기</button></div>
    <div class="status" id="dkgStatus"></div>`;
  $('#kgDetail').querySelectorAll('[data-doc]').forEach((el) => el.onclick = (ev) => {
    if (ev.target.dataset.ex) return;              // 제외 버튼과 분리
    state.selDkgDoc = el.dataset.doc;
    renderDkgDetail();
    if ($('#docGraph').style.display !== 'none') renderDocGraph(g.id).catch(() => {});
  });
  // 멤버/레시피 변경 후 공통 갱신 — 상세 재조회 + (표시 중이면) 문서 그래프도
  const refreshDkg = async () => {
    await reloadKg();
    await selectDkg(g.id, true);
    if ($('#docGraph').style.display !== 'none')
      renderDocGraph(g.id).catch(() => {});
  };
  $('#kgDetail').querySelectorAll('[data-ex]').forEach((b) => b.onclick = async (ev) => {
    ev.stopPropagation();
    try {
      await post(`/api/group/${encodeURIComponent(g.id)}/member`,
                 { document_id: b.dataset.ex, state: 'EXCLUDED' });
      await refreshDkg();
    } catch (e) { $('#dkgStatus').textContent = e.message; }
  });
  const addSel = $('#dkgAddDoc');
  if (addSel) addSel.onchange = async () => {
    if (!addSel.value) return;
    try {
      await post(`/api/group/${encodeURIComponent(g.id)}/member`,
                 { document_id: addSel.value, state: 'INCLUDED' });
      await refreshDkg();
    } catch (e) { $('#dkgStatus').textContent = e.message; }
  };
  $('#dkgSnapshot').onclick = async () => {
    $('#dkgSnapshot').disabled = true;
    try {
      const r = await post(`/api/group/${encodeURIComponent(g.id)}/recipe`, {});
      $('#dkgStatus').textContent =
        `✓ 레시피 저장 — 템플릿 ${r.template}건, 충돌 ${r.conflicts}, 동률 제외 ${r.dropped}`;
      await refreshDkg();
    } catch (e) { $('#dkgStatus').textContent = e.message; $('#dkgSnapshot').disabled = false; }
  };
  const hist = $('#dkgHistory');
  if (hist) hist.onclick = async () => {
    try {
      const r = await api(`/api/group/${encodeURIComponent(g.id)}/recipe`);
      $('#dkgHistBox').innerHTML = r.history.map((h) => `
        <div class="progRow"><span>${esc(h.recipe_id)} · ${esc(h.status)} · ${esc((h.created_at || '').slice(0, 16))}
          ${h.note ? ` · ${esc(h.note.slice(0, 30))}` : ''}</span>
          ${h.status === 'ARCHIVED' ? `<button class="x" data-rb="${esc(h.recipe_id)}"
            style="border:0;background:none;color:var(--blue);cursor:pointer">이 버전으로</button>` : '<span class="badge green">활성</span>'}</div>`).join('');
      $('#dkgHistBox').querySelectorAll('[data-rb]').forEach((b) => b.onclick = async () => {
        try {
          await post(`/api/group/${encodeURIComponent(g.id)}/recipe/${b.dataset.rb}/rollback`, {});
          $('#dkgStatus').textContent = '✓ 롤백 — 해당 버전을 복사한 새 활성 레시피를 만들었습니다.';
          await refreshDkg();
        } catch (e) { $('#dkgStatus').textContent = e.message; }
      });
    } catch (e) { $('#dkgHistBox').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $('#dkgRecrawl').onclick = async () => {
    $('#dkgRecrawl').disabled = true;
    const mode = $('#dkgMode').value;
    const gid = g.id;                      // run과 DKG를 결속 — 오표시 방지
    try {
      const r = await post(`/api/group/${encodeURIComponent(gid)}/recrawl`, { mode });
      const btn = () => $('#dkgRecrawl');
      const prog = () => (state.selDkg === gid ? $('#recrawlProg') : null);
      const draw = (run) => {
        if (run.status === 'POLL_LOST') {  // 네트워크로 폴링만 끊긴 경우
          if (prog()) prog().innerHTML =
            '<div class="empty">진행 조회가 끊겼습니다 — 서버는 계속 실행 중일 수 있습니다. DKG를 다시 선택해 상태를 확인하세요.</div>';
          if (btn()) btn().disabled = false;
          return;
        }
        if (!prog()) {                     // 다른 DKG로 이동 — 화면은 건드리지 않되
          if (run.status !== 'RUNNING') {  // 완료 시 데이터 갱신은 수행
            loadFiles().catch(() => {});
            reloadKg().catch(() => {});
          }
          return;
        }
        const badge = (d) => d.error ? '<span class="badge red">오류</span>'
          : d.map === null ? '<span class="badge">진행 중</span>'
          : `${d.ingest && d.ingest.skipped !== undefined ? '<span class="badge">승계</span>' : '<span class="badge blue">재적재</span>'}
             ${d.recipe && d.recipe.applied ? `<span class="badge blue">레시피 ${d.recipe.applied}</span>` : ''}
             ${(d.map && d.map.REVIEW_REQUIRED) || (d.recipe && d.recipe.review)
               ? `<span class="badge amber">검토 ${(d.map ? d.map.REVIEW_REQUIRED || 0 : 0) + (d.recipe ? d.recipe.review || 0 : 0)}</span>` : ''}
             ${d.recipe && d.recipe.relaxed ? '<span class="badge amber">양식 변경 감지</span>' : ''}`;
        prog().innerHTML = `<div class="sub" style="margin-top:6px">${esc(run.status)} ·
            ${run.summary.length}건</div>` +
          run.summary.map((d) => `<div class="progRow">
            <span>${esc(d.filename)}${d.error ? ` — <span style="color:var(--red)">${esc(d.error)}</span>` : ''}</span>
            <span>${badge(d)}</span></div>`).join('');
        if (run.status !== 'RUNNING') {
          const review = run.summary.reduce((a, d) =>
            a + (d.map ? d.map.REVIEW_REQUIRED || 0 : 0) +
                (d.recipe ? d.recipe.review || 0 : 0), 0);
          prog().innerHTML += `<div class="status">✓ 완료 (${esc(run.status)})` +
            (review ? ` — 검토 필요 ${review}건은 파일 탭에서 검수하세요` : '') + '</div>';
          if (btn()) btn().disabled = false;
          loadFiles().catch(() => {});
          reloadKg().catch(() => {});
          if (state.selDkg === gid && $('#docGraph').style.display !== 'none')
            renderDocGraph(gid).catch(() => {});
        }
      };
      pollRecrawl(r.run_id, draw);
    } catch (e) {
      $('#dkgStatus').textContent = e.message;
      const btn0 = $('#dkgRecrawl');
      if (btn0) btn0.disabled = false;
    }
  };
  $('#docToSource').onclick = () => {
    state.reviewDoc = null;
    show('source');
    loadSheet(state.selDkgDoc, null).catch((e) => setVStatus(e.message));
  };
  $('#backDomain').onclick = () => { state.selDkg = null; graphMode(false); renderDomainGraph(); renderNav(); };
}

// ---- Domain Concept 편집기 (KG2) — 생성/부분 수정/별칭/관계/폐기
const REL_TYPES = ['IS_A', 'PART_OF', 'AFFECTS', 'MEASURED_BY', 'RELATED_TO'];
async function openConceptEditor(cid) {
  let d = { concept: {}, aliases: [], relations: [], active_mappings: 0 };
  if (cid) {
    try { d = await api(`/api/kg/concept/${encodeURIComponent(cid)}`); }
    catch (e) { $('#kgDetail').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  }
  const c = d.concept || {};
  const nameOf = (id) =>
    (state.domain.nodes.find((x) => x.id === id) || { name: id }).name;
  const opt = (list, cur) => list.map((v) =>
    `<option value="${esc(v)}" ${v === (cur || '') ? 'selected' : ''}>${esc(v) || '—'}</option>`).join('');
  $('#kgDetail').innerHTML = `
    <div class="kicker">${cid ? 'EDIT DOMAIN NODE' : 'NEW DOMAIN NODE'}</div>
    <div class="title">${esc(c.canonical_name || '새 개념')}</div>
    ${c.status === 'DEPRECATED' ? '<span class="badge red">폐기됨</span>' : ''}
    ${cid ? `<div class="sub">활성 매핑 ${d.active_mappings}건이 이 개념을 참조합니다.</div>` : ''}
    <div class="editForm">
      <label>이름 (canonical_name)</label><input id="efName" value="${esc(c.canonical_name || '')}">
      <label>영문명</label><input id="efEn" value="${esc(c.canonical_name_en || '')}">
      <label>설명</label><textarea id="efDesc" rows="2">${esc(c.description || '')}</textarea>
      <label>레벨 <span class="muted">(L1 = Document KG 축)</span></label>
      <select id="efLvl">${opt(['', 'L1', 'L2', 'L3'], c.domain_level)}</select>
      <label>데이터 타입</label>
      <select id="efDt">${opt(['', 'numeric', 'text', 'category', 'datetime', 'flag'], c.data_type)}</select>
      <label>기준 단위</label><input id="efUnit" value="${esc(c.canonical_unit || '')}">
    </div>
    ${cid ? `
    <div class="kicker" style="margin-top:12px">ALIASES</div>
    <div>${d.aliases.map((a) => `<span class="chip">${esc(a)}
        <button data-da="${esc(a)}">✕</button></span>`).join('')
      || '<span class="empty">없음</span>'}</div>
    <div style="display:flex;gap:6px;margin-top:6px" class="editForm">
      <input id="efNewAlias" placeholder="새 별칭" style="flex:1;margin-top:0">
      <button class="secondary" id="efAddAlias">추가</button></div>
    <div class="kicker" style="margin-top:12px">RELATIONS</div>
    <div>${d.relations.map((r) => `<span class="chip">${esc(nameOf(r.source_concept_id))}
        —${esc(r.relation_type)}→ ${esc(nameOf(r.target_concept_id))}
        <button data-dr="${esc([r.source_concept_id, r.target_concept_id, r.relation_type].join('|'))}">✕</button></span>`).join('')
      || '<span class="empty">없음</span>'}</div>
    <div class="editForm" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px">
      <select id="efRelType">${REL_TYPES.map((t) => `<option>${t}</option>`).join('')}</select>
      <select id="efRelTarget">
        ${conceptsCache.filter((x) => x.concept_id !== cid).map((x) =>
          `<option value="${esc(x.concept_id)}">${esc(x.canonical_name)}</option>`).join('')}</select>
      <button class="secondary" id="efAddRel" style="grid-column:1/3">이 개념 → 대상 관계 추가</button>
    </div>` : ''}
    <div class="rightBtns">
      <button class="primary" id="efSave">저장</button>
      ${cid ? (c.status === 'DEPRECATED'
        ? '<button class="secondary" id="efRestore">복원</button>'
        : '<button class="secondary" id="efDeprecate">폐기</button>') : ''}
      ${cid ? '<button class="secondary" id="efBack">돌아가기</button>' : ''}
    </div>
    <div class="status" id="efStatus"></div>`;
  const status = (m) => { $('#efStatus').textContent = m; };
  $('#efSave').onclick = async () => {
    $('#efSave').disabled = true;          // 연타 시 새 개념 이중 생성 방지
    const body = {
      concept_id: cid || undefined,
      canonical_name: $('#efName').value.trim() || null,
      canonical_name_en: $('#efEn').value.trim() || null,
      description: $('#efDesc').value.trim() || null,
      domain_level: $('#efLvl').value || null,
      data_type: $('#efDt').value || null,
      canonical_unit: $('#efUnit').value.trim() || null,
    };
    try {
      const r = await post('/api/kg/concept', body);
      await reloadKg();
      status(`✓ 저장됨 (${r.concept_id})`);
      if (r.created) selectNode(r.concept_id);
      else openConceptEditor(cid);
    } catch (e) {
      status(e.message);
      const btn = $('#efSave');
      if (btn) btn.disabled = false;
    }
  };
  if (!cid) return;
  $('#efBack').onclick = () => selectNode(cid);
  $('#kgDetail').querySelectorAll('[data-da]').forEach((b) => b.onclick = async () => {
    try {
      await api(`/api/kg/alias?concept_id=${encodeURIComponent(cid)}&alias=${encodeURIComponent(b.dataset.da)}`,
                { method: 'DELETE' });
      openConceptEditor(cid);
    } catch (e) { status(e.message); }
  });
  $('#efAddAlias').onclick = async () => {
    const a = $('#efNewAlias').value.trim();
    if (!a) return;
    $('#efAddAlias').disabled = true;
    try {
      await post('/api/kg/alias', { concept_id: cid, alias: a });
      status('✓ 별칭 추가 — 미매핑을 재평가하려면 해당 DKG에서 재크롤링(fill)하세요');
      openConceptEditor(cid);
    } catch (e) {
      status(e.message);
      const btn = $('#efAddAlias');
      if (btn) btn.disabled = false;
    }
  };
  $('#kgDetail').querySelectorAll('[data-dr]').forEach((b) => b.onclick = async () => {
    const [s, t, ty] = b.dataset.dr.split('|');
    try {
      const r = await api(`/api/kg/relation?source=${encodeURIComponent(s)}&target=${encodeURIComponent(t)}&type=${encodeURIComponent(ty)}`,
                          { method: 'DELETE' });
      if (r.warning) status(`⚠ ${r.warning}`);
      openConceptEditor(cid);
    } catch (e) { status(e.message); }
  });
  $('#efAddRel').onclick = async () => {
    $('#efAddRel').disabled = true;
    try {
      const r = await post('/api/kg/relation', {
        source: cid, target: $('#efRelTarget').value, type: $('#efRelType').value });
      if (r.warning) status(`⚠ ${r.warning}`);
      await reloadKg();
      openConceptEditor(cid);
    } catch (e) {
      status(e.message);
      const btn = $('#efAddRel');
      if (btn) btn.disabled = false;
    }
  };
  const dep = $('#efDeprecate');
  if (dep) dep.onclick = async () => {
    try {
      await post(`/api/kg/concept/${encodeURIComponent(cid)}/deprecate`, {});
      await reloadKg();
      openConceptEditor(cid);
    } catch (e) { status(e.message); }        // 409: 활성 매핑 n건 참조 안내
  };
  const res = $('#efRestore');
  if (res) res.onclick = async () => {
    try {
      await post(`/api/kg/concept/${encodeURIComponent(cid)}/restore`, {});
      await reloadKg();
      openConceptEditor(cid);
    } catch (e) { status(e.message); }
  };
}

// ================================================================ 3. 원본 데이터
function crumbText() {
  const g = state.selDkg ? dkgOf(state.selDkg) : null;
  const parts = ['<b>전체 KG</b>'];
  if (g) parts.push(esc(g.name));
  if (state.selNode) parts.push(esc(state.selNode.name));
  if (state.reviewDoc) {
    const f = state.files.find((x) => x.document_id === state.reviewDoc);
    parts.push(`${esc(f ? f.filename : '')} 검수`);
  }
  parts.push('원본 데이터');
  return parts.join(' › ');
}

async function renderSourceScreen() {
  $('#srcCrumb').innerHTML = crumbText();
  if (state.reviewDoc) {                      // 검수 모드 (§3.2 검토 큐)
    const rows = await api(`/api/review?doc=${encodeURIComponent(state.reviewDoc)}`);
    $('#srcTitle').textContent = '검수 대기 목록';
    $('#srcSub').textContent = '항목을 클릭해 원본을 확인하고 승인/반려하세요';
    $('#srcList').innerHTML = rows.length ? rows.map((r, i) => `
      <div class="location" data-i="${i}"><b>${esc(r.node_name)}</b> → ${esc(r.concept_id || '?')}
        <div class="sub">${esc(r.filename)} · ${esc((r.locator || '').split('!').pop())} · ${(+r.confidence).toFixed(2)}</div></div>`).join('')
      : '<div class="empty">검수 대기 항목이 없습니다 ✓</div>';
    $('#srcList').querySelectorAll('.location').forEach((el) => el.onclick = () => {
      $('#srcList').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      const r = rows[+el.dataset.i];
      jumpTo(r.document_id, r.locator, r.node_id);
    });
    return;
  }
  if (!state.selNode) {
    $('#srcTitle').textContent = '노드를 선택하세요';
    $('#srcSub').textContent = 'KG 탐색에서 Domain Node를 고르면 매핑된 위치가 나옵니다';
    $('#srcList').innerHTML = '';
    return;
  }
  let res = state.nodeSearch;
  if (!res || res.concept.concept_id !== state.selNode.id) {
    try { res = await api(`/api/search?concept=${encodeURIComponent(state.selNode.id)}`); }
    catch (e) { $('#srcList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    state.nodeSearch = res;
  }
  $('#srcTitle').textContent = state.selNode.name;
  $('#srcSub').textContent = `Document KG에 포함된 문서 중 ${state.selNode.name}에 매핑된 위치`;
  $('#srcList').innerHTML = res.sources.map((s, i) => `
    <div class="location" data-i="${i}"><b>${esc(s.document)}</b>
      <div class="sub">${esc(s.sheet)} · ${esc((s.locator || '').split('!').pop())} · ${s.rows} values · ${s.mapping}${s.status === 'REVIEW_REQUIRED' ? ' ⚠' : ''}</div></div>`).join('')
    || '<div class="empty">연결된 위치 없음</div>';
  $('#srcList').querySelectorAll('.location').forEach((el) => el.onclick = () => {
    $('#srcList').querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
    el.classList.add('sel');
    const s = res.sources[+el.dataset.i];
    jumpTo(s.document_id, s.locator, s.node_id);
  });
}

function jumpTo(documentId, locator, nodeId) {
  const cut = (locator || '').lastIndexOf('!');
  const sheet = cut > 0 ? locator.slice(0, cut) : null;
  loadSheet(documentId, sheet, nodeId)
    // 추월된(loadSheet=false) 호출의 인스펙터가 화면의 시트를 덮지 않게
    .then((applied) => applied !== false && nodeId && openInspector(nodeId))
    .catch((e) => setVStatus(e.message));
}

// ---- Excel 렌더 + Semantic Overlay
function colName(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
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
const setVStatus = (html) => { $('#vstatus').innerHTML = html; };

async function loadSheet(doc, sheet, focusNode) {
  const seq = ++state.seq;
  setVStatus('불러오는 중…');
  const data = await api(`/api/sheet?doc=${encodeURIComponent(doc)}` +
                         (sheet ? `&name=${encodeURIComponent(sheet)}` : ''));
  if (seq !== state.seq) return false;      // 추월됨 — 호출측 후속 동작도 중단
  let allOverlay = [], ovErr = '';
  try { allOverlay = await api(`/api/overlay?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(data.sheet)}`); }
  catch (e) { ovErr = ` · <span style="color:var(--amber)">Overlay 조회 실패: ${esc(e.message.slice(0, 60))}</span>`; }
  const overlay = state.overlayEnabled ? allOverlay : [];
  if (seq !== state.seq) return false;
  state.doc = doc; state.sheet = data.sheet;
  $('#inspector').innerHTML = '<div class="kicker">MAPPING</div>' +
    '<div class="empty">Overlay 영역이나 원본 위치를 클릭하세요</div>';

  $('#tabs').innerHTML = data.sheets.map((s) =>
    `<button class="sheet${s === data.sheet ? ' sel' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('') +
    `<span style="margin-left:auto;display:flex;gap:5px;align-items:center;white-space:nowrap">
      <button class="tinyTab ${state.overlayEnabled ? 'active' : ''}" data-overlay>Semantic Overlay ${state.overlayEnabled ? 'ON' : 'OFF'}</button>
      ${data.viewer && data.viewer.render_status === 'SUCCESS' ? `<a class="tinyTab" target="_blank" rel="noopener"
        href="/api/viewer/documents/${encodeURIComponent(doc)}/preview?document_version=${encodeURIComponent(data.document_version)}">PDF Preview</a>` : ''}
      <span class="muted">원본 충실 렌더 · Read only</span></span>`;
  $('#tabs').querySelectorAll('button[data-s]').forEach((b) => b.onclick = () => loadSheet(doc, b.dataset.s));
  const overlayBtn = $('#tabs [data-overlay]');
  if (overlayBtn) overlayBtn.onclick = () => {
    state.overlayEnabled = !state.overlayEnabled;
    loadSheet(doc, data.sheet, focusNode).catch((e) => setVStatus(e.message));
  };

  const ovAt = new Map();
  for (const o of overlay) {
    const rg = parseRange(o.range);
    if (!rg) continue;
    for (let r = rg.r1; r <= rg.r2; r++)
      for (let c = rg.c1; c <= rg.c2; c++)
        if (!ovAt.has(`${r},${c}`)) ovAt.set(`${r},${c}`, o);
  }
  const focus = focusNode ? overlay.find((o) => o.node_id === focusNode) : null;
  const focusRange = focus ? parseRange(focus.range) : null;

  const byPos = new Map();
  for (const c of data.cells) byPos.set(`${c.r},${c.c}`, c);
  const covered = new Set();
  for (const c of data.cells)
    for (let r = c.r; r < c.r + (c.rs || 1); r++)
      for (let k = c.c; k < c.c + (c.cs || 1); k++)
        if (r !== c.r || k !== c.c) covered.add(`${r},${k}`);

  // 원본 충실 렌더: 열폭/행고/테두리/폰트/정렬/이미지를 그대로 재현한다 (§10.1)
  const HDRW = 34, HDRH = 22;
  const grid = data.gridlines ? '1px solid #e9edf2' : '1px solid transparent';
  let html = `<table class="grid" style="table-layout:fixed;border-collapse:collapse">
    <colgroup><col style="width:${HDRW}px">` +
    data.cols.map((w) => `<col style="width:${w}px">`).join('') + '</colgroup>';
  html += `<tr style="height:${HDRH}px"><td class="hd"></td>`;
  for (let c = 1; c <= data.max_col; c++) html += `<td class="hd">${colName(c)}</td>`;
  html += '</tr>';
  for (let r = 1; r <= data.max_row; r++) {
    html += `<tr style="height:${data.rows[r - 1]}px"><td class="hd">${r}</td>`;
    for (let c = 1; c <= data.max_col; c++) {
      if (covered.has(`${r},${c}`)) continue;
      const cell = byPos.get(`${r},${c}`);
      const ov = ovAt.get(`${r},${c}`);
      const inFocus = focusRange && r >= focusRange.r1 && r <= focusRange.r2 &&
                      c >= focusRange.c1 && c <= focusRange.c2;
      const cls = (ov && ov.role !== 'IGNORE' ? ` ov ov-${ov.role}` : (ov ? ' ov' : '')) +
                  (inFocus ? ' selc' : '');
      const st = [`border:${grid}`];
      if (cell) {
        if (cell.f) st.push(`background:${esc(cell.f)}`);
        if (cell.b) st.push('font-weight:700');
        if (cell.i) st.push('font-style:italic');
        if (cell.sz) st.push(`font-size:${cell.sz}px`);
        if (cell.fc) st.push(`color:${esc(cell.fc)}`);
        if (cell.ha) st.push(`text-align:${{ l: 'left', c: 'center', r: 'right' }[cell.ha]}`);
        else if (cell.n) st.push('text-align:right');
        if (cell.wr) st.push('white-space:normal;word-break:break-all');
        if (cell.bd) {
          if (cell.bd.t) st.push(`border-top:${esc(cell.bd.t)}`);
          if (cell.bd.r) st.push(`border-right:${esc(cell.bd.r)}`);
          if (cell.bd.b) st.push(`border-bottom:${esc(cell.bd.b)}`);
          if (cell.bd.l) st.push(`border-left:${esc(cell.bd.l)}`);
        }
      }
      html += `<td${cls.trim() ? ` class="${cls.trim()}"` : ''}` +
        `${ov ? ` data-node="${esc(ov.node_id)}"` : ''}` +
        `${cell && cell.rs ? ` rowspan="${cell.rs}"` : ''}` +
        `${cell && cell.cs ? ` colspan="${cell.cs}"` : ''}` +
        ` style="${st.join(';')}"` +
        ` title="${colName(c)}${r}${ov ? ` · ${esc(ov.concept_name || ov.header)} [${esc(ov.role)}]` : ''}">` +
        `${cell ? esc(cell.v) : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  // 이미지 오버레이 — 앵커 px 좌표에 절대 배치 (원본 도형/사진 보존)
  const imgs = (data.images || []).map((im) =>
    `<img src="${im.src}" style="position:absolute;left:${HDRW + im.x}px;` +
    `top:${HDRH + im.y}px;width:${im.w}px;height:${im.h}px;` +
    `box-shadow:0 1px 4px rgba(20,30,50,.18);pointer-events:none">`).join('');
  $('#gridwrap').innerHTML =
    `<div style="position:relative;display:inline-block">${html}${imgs}</div>`;
  $('#gridwrap').querySelectorAll('td.ov').forEach((td) =>
    td.onclick = () => openInspector(td.dataset.node));
  const roles = {};
  allOverlay.forEach((o) => roles[o.role] = (roles[o.role] || 0) + 1);
  const rolesTxt = !state.overlayEnabled ? '<span class="muted">Semantic Overlay 숨김</span>' : allOverlay.length
    ? `Overlay <span class="badge green">KEY ${roles.KEY || 0}</span>
       <span class="badge blue">VALUE ${roles.VALUE || 0}</span>
       <span class="badge amber">CONTEXT ${roles.CONTEXT || 0}</span>
       <span class="badge">미매핑 ${roles.IGNORE || 0}</span>`
    : '<span style="color:var(--amber)">이 시트에는 매핑된 영역이 없습니다</span>';
  setVStatus(`${esc(data.sheet)} — ${data.max_row}×${data.max_col}` +
    `${data.truncated ? ' (잘림)' : ''} · ${rolesTxt}${ovErr}` +
    `${data.viewer ? ` · DRM ${esc(data.viewer.drm_status)} · Render ${esc(data.viewer.render_status || 'PENDING')}` : ' · Viewer source 미등록'}`);
  const selCell = $('#gridwrap td.selc');
  if (selCell) selCell.scrollIntoView({ block: 'center', inline: 'center' });
}

// ---- Inspector (MAPPING 패널)
let conceptsCache = [];
async function openInspector(nodeId) {
  const d = await api(`/api/source/${encodeURIComponent(nodeId)}`);
  const inCart = cart().some((x) => x.node_id === nodeId);
  const isReview = d.mapping && d.mapping.status === 'REVIEW_REQUIRED';
  const unmapped = !d.mapping || !d.mapping.concept_id || d.mapping.status === 'UNMAPPED';
  const opts = ['<option value="" disabled' + (unmapped ? ' selected' : '') + '>— 개념 선택 —</option>',
    ...conceptsCache.map((c) =>
      `<option value="${esc(c.concept_id)}" ${!unmapped && d.mapping.concept_id === c.concept_id ? 'selected' : ''}>` +
      `${esc(c.canonical_name)} (${esc(c.concept_id)})</option>`)].join('');
  const sourceText = (source) => source
    ? `${esc(source.sheet || d.sheet)}!${esc(source.range || '동적 탐색')}` : '—';
  const ps = d.parsing_source;
  const pt = d.parsing_template;
  $('#inspector').innerHTML = `
    <div class="kicker">SOURCE INSPECTOR</div><div class="title">${esc(d.range)}</div>
    <div class="sub">${esc(d.document)} · ${esc(d.document_version || 'version 없음')} · Read only</div>
    <div class="kv"><strong>${esc(d.role)} → ${esc(d.concept_name || '미매핑')}</strong>
      <p>Header: ${esc(d.header)}${d.unit ? ` · ${esc(d.unit)}` : ''}
      ${d.mapping ? ` · ${esc(d.mapping.status)} (${d.mapping.confidence})` : ''}</p>
      ${d.mapping && d.mapping.method ? `<p style="font-size:11px;color:var(--muted)">
        ${d.mapping.method === 'recipe' ? '<span class="badge blue">레시피</span> ' : ''}방법: ${esc(d.mapping.method)}
        ${d.mapping.reason ? `<br>${esc(d.mapping.reason)}` : ''}</p>` : ''}</div>
    <div class="kv"><strong>KEY · Row Context</strong>
      <p>인접: ${esc((d.row_context.keys || []).join(', ') || '—')}<br>
         경로: ${esc((d.row_context.header_path || []).join(' › ') || '—')}</p></div>
    <div class="kv"><strong>CONTEXT</strong>
      <p>Sheet: ${esc(d.sheet)} · 문서: ${esc(d.document)}</p></div>
    <div class="kv"><strong>VIEWER SOURCE</strong>
      <p>DRM: ${esc(d.viewer ? d.viewer.drm_status : '미등록')} · Render: ${esc(d.viewer ? d.viewer.render_status : '미등록')}<br>
      Document Version: ${esc(d.document_version || '—')}</p></div>
    <div class="kv"><strong>PARSING TEMPLATE</strong>
      ${pt ? `<p>▣ ${esc(pt.template_name)} v${esc(pt.template_version)} · ${esc(pt.status)}<br>
        Mapping: ${esc(ps ? ps.mapping_source : 'Template source 미연결')}
        ${ps && ps.override_status ? ` · ${esc(ps.override_status)}` : ''}<br>
        Template Source: ${sourceText(ps && ps.template_source)}<br>
        Effective Source: <b>${sourceText(ps && ps.effective_source)}</b>
        ${ps && ps.override_reason ? `<br>사유: ${esc(ps.override_reason)}` : ''}</p>`
        : '<p>이 Document Version에 배정된 Parsing Template이 없습니다.</p>'}</div>
    <div style="margin-top:12px" class="kicker">DOMAIN CONCEPT</div>
    <select id="conceptSel">${opts}</select>
    <div style="margin-top:12px" class="kicker">VALUE PREVIEW</div>
    <div style="display:grid;grid-template-columns:52px 1fr 44px;gap:5px;margin-top:6px;font-size:12px;line-height:22px">
      ${d.values.map((v, i) => `<span class="muted">${esc(v.key ?? String(i + 1).padStart(2, '0'))}</span>
        <b style="text-align:right">${esc(v.value)}</b><span class="muted">${esc(d.unit || '')}</span>`).join('')}</div>
    ${isReview ? `<div style="display:flex;gap:8px;margin-top:12px">
      <button class="primary" style="flex:1" id="approveBtn">승인</button>
      <button class="secondary" style="flex:1" id="rejectBtn">반려</button></div>` : ''}
    <button class="primary w100" style="margin-top:10px" id="includeBtn"
      ${inCart || unmapped ? 'disabled' : ''}>${inCart ? '✓ 이미 포함됨' : (unmapped ? '매핑 확정 후 포함 가능' : '이 Source 포함')}</button>
    <button class="secondary w100" style="margin-top:8px" id="remapBtn">매핑 수정</button>
    <div class="status" id="insStatus"></div>`;
  if (isReview) {
    const act = (action) => async () => {
      try {
        await post('/api/review', { mapping_id: d.mapping.mapping_id, action });
        $('#insStatus').textContent = action === 'approve' ? '✓ 승인되었습니다.'
          : ('반려되었습니다.' + (d.mapping.method === 'recipe'
             ? ' 이 양식 전체를 고치려면: 매핑 수정 후 레시피 재저장 → reset_auto 재크롤링.'
             : ''));
        state.nodeSearch = null;           // 소스 목록의 ⚠/매핑 라벨 stale 방지
        loadFiles().catch(() => {});
        if (state.reviewDoc) renderSourceScreen();
        loadSheet(state.doc, state.sheet, nodeId).catch(() => {});
      } catch (e) { $('#insStatus').textContent = e.message; }
    };
    $('#approveBtn').onclick = act('approve');
    $('#rejectBtn').onclick = act('reject');
  }
  $('#includeBtn').onclick = () => {
    addToCart({ node_id: nodeId, concept_id: d.mapping.concept_id, header: d.header,
                document: d.document, sheet: d.sheet, range: d.range, role: d.role });
    $('#insStatus').textContent = '✓ 통합 DB 초안에 포함되었습니다.';
    $('#includeBtn').disabled = true;
    $('#includeBtn').textContent = '✓ 이미 포함됨';
  };
  $('#remapBtn').onclick = async () => {
    const concept_id = $('#conceptSel').value;
    if (!concept_id) { $('#insStatus').textContent = '개념을 먼저 선택하세요.'; return; }
    $('#remapBtn').disabled = true;
    try {
      await post('/api/remap', { node_id: nodeId, concept_id });
      $('#insStatus').textContent = `✓ ${concept_id} 로 매핑을 확정했습니다.`;
      state.nodeSearch = null;             // 소스 목록/카운트 stale 방지
      loadSheet(state.doc, state.sheet, nodeId).then(() => openInspector(nodeId)).catch(() => {});
    } catch (e) { $('#insStatus').textContent = e.message; $('#remapBtn').disabled = false; }
  };
}

// ================================================================ 4. 통합 DB
let proposal = null;
function renderCartList() {
  const c = cart();
  const byConcept = {};
  c.forEach((x) => { (byConcept[x.concept_id || '(미매핑)'] ||= []).push(x); });
  $('#cart').innerHTML = Object.entries(byConcept).map(([cid, items]) =>
    `<span class="badge blue" style="margin:2px 3px">${esc(cid)} · ${items.length}
      <button class="x" data-c="${esc(cid)}" style="border:0;background:none;color:var(--red);cursor:pointer">✕</button></span>`).join('')
    || '<span class="empty">비어 있음</span>';
  $('#cart').querySelectorAll('.x').forEach((b) => b.onclick = () => {
    saveCart(cart().filter((x) => (x.concept_id || '(미매핑)') !== b.dataset.c));
    refreshProposal();
  });
}

async function refreshProposal() {
  renderCartList();
  const c = cart();
  $('#mSrc').textContent = c.length;
  $('#mDocs').textContent = new Set(c.map((x) => x.document)).size;
  if (!c.length) {
    $('#schemaRows').innerHTML = '<tr><td colspan="6" class="empty">원본 데이터 화면에서 \'이 Source 포함\' 또는 KG 탐색의 \'통합 DB 대상에 추가\'로 담으세요</td></tr>';
    $('#schemaTree').textContent = '결과 스키마가 여기 표시됩니다';
    proposal = null;
    return;
  }
  proposal = await post('/api/proposal', { node_ids: c.map((x) => x.node_id) });
  if (proposal.stale_node_ids && proposal.stale_node_ids.length) {
    const stale = new Set(proposal.stale_node_ids);
    saveCart(c.filter((x) => !stale.has(x.node_id)));
    $('#buildStatus').textContent =
      `⚠ 재적재로 사라진 위치 ${stale.size}건을 묶음에서 제거했습니다.`;
    renderCartList();
  }
  $('#schemaRows').innerHTML = proposal.fields.map((f, i) => `
    <tr><td><input value="${esc(f.field_name)}" data-f="${i}"
        style="border:1px solid var(--line);border-radius:6px;padding:4px 6px;width:140px"></td>
      <td>${esc(f.concept_name)}</td>
      <td><span class="badge ${ROLE_BADGE[f.role] || ''}">${esc(f.role || '')}</span></td>
      <td>${f.sources}</td><td>${esc(f.note)}</td>
      <td style="color:${f.status === '검토' ? 'var(--amber)' : 'var(--green)'}">${esc(f.status)}</td></tr>`).join('');
  $('#schemaRows').querySelectorAll('input').forEach((inp) =>
    inp.onchange = () => { proposal.fields[+inp.dataset.f].field_name = inp.value.trim(); });
  const name = $('#dbName').value.trim() || 'result';
  $('#schemaTree').textContent = [name,
    ...proposal.fields.map((f, i) =>
      `${i === proposal.fields.length - 1 ? '└─' : '├─'} ${f.field_name} ${(f.type || 'text').toUpperCase()}${f.target_unit ? ' · ' + f.target_unit : ''}`),
    '├─ _source_document_id', '├─ _source_sheet', '└─ _source_locator'].join('\n');
}

$('#clearCart').onclick = () => { saveCart([]); refreshProposal(); $('#result').innerHTML = ''; };

$('#buildDb').onclick = async () => {
  if (!proposal || !proposal.fields.filter((f) => f.sources > 0).length) {
    $('#buildStatus').textContent = '사용 가능한 소스가 없습니다 — 검토 대기 항목은 승인 후 포함됩니다.';
    return;
  }
  const name = ($('#dbName').value.trim() || 'result').replace(/[^A-Za-z0-9_]/g, '_');
  $('#buildDb').disabled = true;
  $('#buildStatus').textContent = 'BUILDING…';
  try {
    const fields = proposal.fields.filter((f) => f.sources > 0);
    const body = {
      name,
      fields: fields.map((f) => ({
        name: f.field_name.replace(/[^A-Za-z0-9_]/g, '_') || f.concept_id,
        concept: f.concept_id, unit: f.target_unit, type: f.type })),
      include_nodes: Object.fromEntries(fields.map((f) => [
        f.field_name.replace(/[^A-Za-z0-9_]/g, '_') || f.concept_id, f.node_ids])),
    };
    const r = await post('/api/build', body);
    state.lastBuild = name;
    $('#buildStatus').innerHTML = `✓ ${esc(r.status)} — 재실행하면 새 버전이 생성됩니다`;
    $('#buildDb').textContent = 'DB 다시 생성 (새 버전)';
    const cols = r.preview.length ? Object.keys(r.preview[0]).filter((k) => !k.startsWith('_')) : [];
    $('#result').innerHTML = `
      <div style="margin-top:14px;border-top:1px solid var(--line);padding-top:12px">
      <div class="kicker">RESULT</div>
      <div class="sub"><b style="color:var(--blue)">${esc(r.table)}</b> · ${r.row_count} rows ·
        Lineage ${r.lineage.edges}셀/${r.lineage.documents}문서<br>
        artifact: <code style="font-size:11px">${esc(r.artifact)}</code></div>
      ${r.build_report.warnings.length ? `<div class="warn">⚠ ${r.build_report.warnings.map((w) =>
        esc(w.field ? `${w.field}: ${w.reason}` : `${w.column || ''} ${w.from || ''}→${w.to || ''} ${w.cells || ''}건 미변환`)).join('<br>⚠ ')}</div>` : ''}
      <table class="table" style="margin-top:8px"><thead><tr><th>필드</th><th>Concept</th><th>단위</th><th>포함</th></tr></thead>
        <tbody>${r.schema.map((s) => `<tr><td>${esc(s.field)}</td><td>${esc(s.concept)}</td>
          <td>${esc(s.unit || '—')}</td><td>${s.included === false ? '<span style="color:var(--red)">제외됨</span>' : '✓'}</td></tr>`).join('')}</tbody></table>
      <div class="kicker" style="margin-top:10px">PREVIEW</div>
      <div style="overflow-x:auto"><table class="table"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${r.preview.map((row) => `<tr>${cols.map((c) => `<td>${esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  } catch (e) {
    $('#buildStatus').textContent = `실패: ${e.message}`;
  }
  $('#buildDb').disabled = false;
};

// ================================================================ init
(async () => {
  try {
    [state.domain, state.dkgs, conceptsCache] = await Promise.all([
      api('/api/kg/domain'), api('/api/kg/document'), api('/api/concepts')]);
  } catch (e) {
    document.body.insertAdjacentHTML('afterbegin',
      `<div style="background:#fbe9e9;padding:10px 24px">${esc(e.message)}</div>`);
    return;
  }
  renderDomainGraph();
  renderNav();
  loadFiles().catch(() => {});
  saveCart(cart());
  $('#navDomain').onclick = () => {
    $('#navDomain').classList.add('active'); $('#navDoc').classList.remove('active');
    $('#domainList').style.display = ''; $('#docList').style.display = 'none';
  };
  $('#navDoc').onclick = () => {
    $('#navDoc').classList.add('active'); $('#navDomain').classList.remove('active');
    $('#domainList').style.display = 'none'; $('#docList').style.display = '';
  };
  $('#newConceptBtn').onclick = () => openConceptEditor(null);
  $('#showDomainGraph').onclick = () => graphMode(false);
  $('#showDocGraph').onclick = () => {
    if (!state.selDkg && state.dkgs.length) state.selDkg = state.dkgs[0].id;
    renderNav($('#kgSearch').value.trim());
    graphMode(true);
    renderDkgDetail();
  };
  let t = null;
  $('#kgSearch').oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => renderNav(e.target.value.trim()), 200);
  };
  $('#dbName').oninput = () => { if (proposal) refreshProposal(); };
})();
