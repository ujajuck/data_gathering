import { api, el, fmt } from '../api.js';
import { renderLineage } from '../components/lineage-svg.js';

export default async function lineage(root) {
  const [concepts, lots] = await Promise.all([
    api('/api/concepts?used=true&size=200'),
    api('/api/lots?size=200'),
  ]);
  if (!concepts.items.length) {
    root.append(el('div', { class: 'panel' },
      el('p', { class: 'empty' }, '매핑된 개념이 없습니다 — 먼저 data/raw를 ingest 하세요')));
    return;
  }
  const cSel = el('select', {}, concepts.items.map(c =>
    el('option', { value: c.concept_id }, `${c.name_ko} (${c.concept_id})`)));
  const lSel = el('select', {},
    el('option', { value: '' }, '모든 LOT'),
    lots.items.map(l => el('option', { value: l.lot }, l.lot)));
  if (concepts.items.some(c => c.concept_id === 'reaction_temperature')) cSel.value = 'reaction_temperature';
  if (lots.items.some(l => l.lot === 'BT26821')) lSel.value = 'BT26821';

  const fig = el('div');
  const tbl = el('div');

  async function load() {
    const meta = concepts.items.find(c => c.concept_id === cSel.value) || {};
    const lot = lSel.value;
    const data = await api(`/api/lineage/${encodeURIComponent(cSel.value)}${lot ? `?lot=${encodeURIComponent(lot)}` : ''}`);
    const items = data.items.slice(0, 8);
    renderLineage(fig, { conceptName: meta.name_ko || cSel.value, conceptId: cSel.value,
                         unit: meta.canonical_unit || '', items });
    tbl.replaceChildren(el('div', { class: 'tblwrap' }, el('table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, 'LOT'), el('th', {}, '문서'), el('th', {}, '셀'),
        el('th', {}, '원시값'), el('th', {}, '정규화값'), el('th', {}, 'DVC hash'))),
      el('tbody', {}, data.items.map(o => el('tr', {},
        el('td', { class: 'mono' }, o.lot || ''),
        el('td', { class: 'dim' }, o.document),
        el('td', { class: 'mono' }, `${o.source_sheet}!${o.source_address}`),
        el('td', { class: 'num' }, `${fmt(o.raw_value_num ?? o.raw_value_text ?? '')} ${o.raw_unit || ''}`),
        el('td', { class: 'num', style: 'font-weight:500' },
          `${fmt(o.normalized_value_num ?? o.normalized_value_text ?? '')} ${o.canonical_unit || ''}`),
        el('td', { class: 'mono dim' }, (o.dvc_hash || '').slice(0, 10))))))));
  }

  cSel.addEventListener('change', load);
  lSel.addEventListener('change', load);
  root.append(
    el('div', { class: 'panel' },
      el('div', { class: 'toolbar' }, cSel, lSel),
      fig),
    el('div', { class: 'panel' }, el('h3', {}, '관측치 상세 (원시값 → 정규화값, 출처 보존)'), tbl));
  await load();
}
