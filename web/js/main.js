// hash 라우터 + 앱 셸 (WEB_PLAN §2)
import { api, el } from './api.js';
import ontology from './views/ontology.js';
import graph from './views/graph.js';
import mapping from './views/mapping.js';
import units from './views/units.js';
import hub from './views/hub.js';
import lineage from './views/lineage.js';
import workbook from './views/workbook.js';

const VIEWS = {
  ontology: { no: '1', title: '개념 온톨로지', desc: '6개 도메인 아래의 표준 개념 계층과 단위', load: ontology },
  graph:    { no: '2', title: '지식 그래프', desc: '배치(LOT) 허브 중심 엔티티 관계 — 근거는 실제 레코드 동시출현', load: graph },
  mapping:  { no: '3', title: '문서-개념 매핑', desc: '문서별 매핑 현황과 검토 대기 승인 (승인은 동의어 사전으로 승격)', load: mapping },
  units:    { no: '4', title: '단위 정규화', desc: '같은 LOT의 같은 물리량이 문서마다 다른 표기 → 표준 단위 수렴', load: units },
  hub:      { no: '5', title: 'LOT 허브', desc: 'business key 조인으로 문서 횡단 통합 (선택 시 상세 lazy 로딩)', load: hub },
  lineage:  { no: '6', title: 'Lineage 추적', desc: '개념 하나의 원본 셀 → 변환 → 표준값 흐름', load: lineage },
  workbook: { no: '7', title: '레코드 브라우저', desc: '표준 Record/Observation 계약 — 서버 페이지네이션', load: workbook },
};

const nav = document.getElementById('nav');
const main = document.getElementById('view');

for (const [id, v] of Object.entries(VIEWS)) {
  nav.append(el('li', {}, el('a', { href: `#/${id}`, id: `nav-${id}` },
    el('span', { class: 'no' }, v.no), v.title)));
}

async function loadStats() {
  try {
    const s = await api('/api/stats');
    document.getElementById('nav-stats').replaceChildren(
      el('div', {}, '문서 ', el('b', {}, String(s.documents))),
      el('div', {}, '레코드 ', el('b', {}, s.records.toLocaleString())),
      el('div', {}, '관측치 ', el('b', {}, s.observations.toLocaleString())),
      el('div', {}, '매핑 ', el('b', {}, `${s.mapped_pct}%`)),
      el('div', {}, '검토 대기 ', el('b', {}, String(s.pending_mappings))));
  } catch { /* 토스트로 이미 알림 */ }
}

let gen = 0;   // 내비게이션 세대 토큰 — 늦게 끝난 이전 뷰의 DOM 오염 방지

async function route() {
  const my = ++gen;
  const id = (location.hash.replace(/^#\//, '') || 'ontology').split('/')[0];
  const view = VIEWS[id] || VIEWS.ontology;
  document.querySelectorAll('aside.nav a').forEach(a => a.classList.remove('active'));
  document.getElementById(`nav-${VIEWS[id] ? id : 'ontology'}`)?.classList.add('active');
  document.title = `${view.title} — 공정 데이터 온톨로지`;
  // 뷰마다 전용 컨테이너: 이전 라우트의 미완료 load는 detach된 컨테이너에
  // append하게 되어 화면에 나타나지 않는다.
  const body = el('div');
  main.replaceChildren(el('div', { class: 'view-head' },
    el('h1', {}, view.title), el('p', {}, view.desc)), body);
  try {
    await view.load(body);
  } catch (e) {
    if (my === gen) {
      body.append(el('div', { class: 'panel' },
        el('p', { class: 'empty' }, `뷰를 불러오지 못했습니다 — ${e.message}`)));
    }
  }
  if (my === gen) loadStats();
}

window.addEventListener('hashchange', route);
route();
