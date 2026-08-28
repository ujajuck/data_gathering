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
  selNode: null,          // {id, name}
  selDkg: null,           // dkg id
  selDkgDoc: null,        // Document KG 상세에서 선택한 문서
  reviewDoc: null,        // 검수 모드 대상 문서
  doc: null, sheet: null, seq: 0,
  lastBuild: null,
};

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
      <td><span class="badge ${cls}">${esc(label)}</span></td>
      <td><button class="secondary" data-open="${esc(f.document_id)}">열어보기</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">등록된 파일이 없습니다 — kg ingest를 먼저 실행하세요</td></tr>';
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
      <button class="secondary" id="addNodeCart">통합 DB 대상에 추가</button></div>
    <div class="status" id="kgStatus"></div>`;
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

function selectDkg(dkgId) {
  state.selDkg = dkgId;
  state.selDkgDoc = null;
  renderDomainGraph();
  renderNav($('#kgSearch').value.trim());
  renderDkgDetail();
}

function renderDkgDetail() {
  const g = state.dkgDetail && state.dkgDetail.id === state.selDkg
    ? state.dkgDetail : dkgOf(state.selDkg);
  if (!g) return;
  const selDoc = (g.member_documents || []).find((d) => d.document_id === state.selDkgDoc);
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
    <div style="max-height:30vh;overflow-y:auto">
    ${(g.member_documents || []).map((d) => `
      <div class="fileRow${state.selDkgDoc === d.document_id ? ' sel' : ''}" data-doc="${esc(d.document_id)}">
        <b>${esc(d.filename)}</b><div>${esc(d.nodes.slice(0, 4).join(' · '))} · ${d.sources} src</div></div>`).join('')}
    </div>
    <div class="rightBtns">
      <button class="primary" id="docToSource" ${selDoc ? '' : 'disabled'}>선택 문서의 원본 위치 보기</button>
      <button class="secondary" id="backDomain">전체 KG로 돌아가기</button></div>`;
  $('#kgDetail').querySelectorAll('[data-doc]').forEach((el) => el.onclick = () => {
    state.selDkgDoc = el.dataset.doc;
    renderDkgDetail();
    if ($('#docGraph').style.display !== 'none') renderDocGraph(g.id).catch(() => {});
  });
  $('#docToSource').onclick = () => {
    state.reviewDoc = null;
    show('source');
    loadSheet(state.selDkgDoc, null).catch((e) => setVStatus(e.message));
  };
  $('#backDomain').onclick = () => { state.selDkg = null; graphMode(false); renderDomainGraph(); renderNav(); };
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
    .then(() => nodeId && openInspector(nodeId))
    .catch((e) => setVStatus(e.message));
}

// ---- Excel 렌더 + Semantic Overlay
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
const setVStatus = (html) => { $('#vstatus').innerHTML = html; };

async function loadSheet(doc, sheet, focusNode) {
  const seq = ++state.seq;
  setVStatus('불러오는 중…');
  const data = await api(`/api/sheet?doc=${encodeURIComponent(doc)}` +
                         (sheet ? `&name=${encodeURIComponent(sheet)}` : ''));
  if (seq !== state.seq) return;
  let overlay = [], ovErr = '';
  try { overlay = await api(`/api/overlay?doc=${encodeURIComponent(doc)}&name=${encodeURIComponent(data.sheet)}`); }
  catch (e) { ovErr = ` · <span style="color:var(--amber)">Overlay 조회 실패: ${esc(e.message.slice(0, 60))}</span>`; }
  if (seq !== state.seq) return;
  state.doc = doc; state.sheet = data.sheet;
  $('#inspector').innerHTML = '<div class="kicker">MAPPING</div>' +
    '<div class="empty">Overlay 영역이나 원본 위치를 클릭하세요</div>';

  $('#tabs').innerHTML = data.sheets.map((s) =>
    `<button class="sheet${s === data.sheet ? ' sel' : ''}" data-s="${esc(s)}">${esc(s)}</button>`).join('') +
    `<span class="muted" style="margin-left:auto;padding:6px;white-space:nowrap">원본 렌더 + Semantic Overlay</span>`;
  $('#tabs').querySelectorAll('button').forEach((b) => b.onclick = () => loadSheet(doc, b.dataset.s));

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
      const cls = (ov && ov.role !== 'IGNORE' ? ` ov ov-${ov.role}` : (ov ? ' ov' : '')) +
                  (inFocus ? ' selc' : '');
      const style = [];
      if (cell && cell.f) style.push(`background:${esc(cell.f)}`);
      if (cell && cell.b) style.push('font-weight:700');
      html += `<td${cls.trim() ? ` class="${cls.trim()}"` : ''}` +
        `${ov ? ` data-node="${esc(ov.node_id)}"` : ''}` +
        `${cell && cell.rs > 1 ? ` rowspan="${cell.rs}"` : ''}` +
        `${cell && cell.cs > 1 ? ` colspan="${cell.cs}"` : ''}` +
        `${style.length ? ` style="${style.join(';')}"` : ''}` +
        ` title="${colName(c)}${r}${ov ? ` · ${esc(ov.concept_name || ov.header)} [${esc(ov.role)}]` : ''}">` +
        `${cell ? esc(cell.v) : ''}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  $('#gridwrap').innerHTML = html;
  $('#gridwrap').querySelectorAll('td.ov').forEach((td) =>
    td.onclick = () => openInspector(td.dataset.node));
  const roles = {};
  overlay.forEach((o) => roles[o.role] = (roles[o.role] || 0) + 1);
  const rolesTxt = overlay.length
    ? `Overlay <span class="badge green">KEY ${roles.KEY || 0}</span>
       <span class="badge blue">VALUE ${roles.VALUE || 0}</span>
       <span class="badge amber">CONTEXT ${roles.CONTEXT || 0}</span>
       <span class="badge">미매핑 ${roles.IGNORE || 0}</span>`
    : '<span style="color:var(--amber)">이 시트에는 매핑된 영역이 없습니다</span>';
  setVStatus(`${esc(data.sheet)} — ${data.max_row}×${data.max_col}` +
    `${data.truncated ? ' (잘림)' : ''} · ${rolesTxt}${ovErr}`);
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
  $('#inspector').innerHTML = `
    <div class="kicker">MAPPING</div><div class="title">${esc(d.range)}</div>
    <div class="kv"><strong>${esc(d.role)} → ${esc(d.concept_name || '미매핑')}</strong>
      <p>Header: ${esc(d.header)}${d.unit ? ` · ${esc(d.unit)}` : ''}
      ${d.mapping ? ` · ${esc(d.mapping.status)} (${d.mapping.confidence})` : ''}</p></div>
    <div class="kv"><strong>KEY · Row Context</strong>
      <p>인접: ${esc((d.row_context.keys || []).join(', ') || '—')}<br>
         경로: ${esc((d.row_context.header_path || []).join(' › ') || '—')}</p></div>
    <div class="kv"><strong>CONTEXT</strong>
      <p>Sheet: ${esc(d.sheet)} · 문서: ${esc(d.document)}</p></div>
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
        $('#insStatus').textContent = action === 'approve' ? '✓ 승인되었습니다.' : '반려되었습니다.';
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
