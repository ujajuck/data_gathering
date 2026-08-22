import { api, el } from '../api.js';
import { renderGraph } from '../components/kg-svg.js';

export default async function graph(root) {
  const data = await api('/api/graph');
  const fig = el('div');
  renderGraph(fig, data);
  const rows = data.edges.map(e => el('tr', {},
    el('td', {}, e.name_ko),
    el('td', { class: 'mono dim' }, `${e.subject} —${e.predicate}→ ${e.object}`),
    el('td', { class: 'num' }, String(e.evidence_records))));
  root.append(
    el('div', { class: 'panel' }, fig),
    el('div', { class: 'panel' },
      el('h3', {}, '관계 정의와 근거'),
      el('div', { class: 'tblwrap' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, '관계'), el('th', {}, '정의'), el('th', {}, '근거 레코드'))),
        el('tbody', {}, rows)))));
}
