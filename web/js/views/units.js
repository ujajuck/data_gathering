import { api, el, fmt } from '../api.js';

export default async function units(root) {
  const lots = await api('/api/lots?size=200');
  if (!lots.items.length) {
    root.append(el('div', { class: 'panel' },
      el('p', { class: 'empty' }, '표시할 LOT이 없습니다 — 먼저 data/raw를 ingest 하세요')));
    return;
  }
  const select = el('select', {}, lots.items.map(l => el('option', { value: l.lot }, l.lot)));
  const body = el('div');
  const preferred = lots.items.find(l => l.sheet_count >= 3);
  if (preferred) select.value = preferred.lot;

  async function load() {
    const d = await api(`/api/lots/${encodeURIComponent(select.value)}`);
    const rows = [];
    for (const [cid, vals] of Object.entries(d.concepts)) {
      const variants = [];
      const seen = new Set();
      for (const v of vals) {
        const k = `${v.raw}|${v.raw_unit}`;
        if (seen.has(k) || v.raw === null || v.raw === undefined) continue;
        seen.add(k);
        variants.push(el('span', { class: 'var' }, fmt(v.raw), ' ', el('i', {}, v.raw_unit || '')));
      }
      if (variants.length < 2 && !vals.some(v => v.raw_unit && v.unit && v.raw_unit !== v.unit)) continue;
      const norm = [...new Set(vals.map(v => `${fmt(v.value)} ${v.unit || ''}`.trim()))];
      rows.push(el('tr', {},
        el('td', {}, variants),
        el('td', {}, el('span', { class: 'cnode' }, cid, vals[0].unit ? el('i', {}, ` (${vals[0].unit})`) : '')),
        el('td', { class: 'num', style: 'font-weight:500;white-space:nowrap' }, norm.join(' · '))));
    }
    body.replaceChildren(rows.length
      ? el('div', { class: 'tblwrap' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '다양한 원본 표현'), el('th', {}, '표준 개념'), el('th', {}, '통합 저장 값'))),
          el('tbody', {}, rows)))
      : el('p', { class: 'empty' }, '이 LOT에는 복수 표현 개념이 없습니다'));
  }

  select.addEventListener('change', load);
  root.append(el('div', { class: 'panel' },
    el('div', { class: 'toolbar' }, el('label', { class: 'dim', style: 'align-self:center' }, 'LOT '), select),
    body));
  await load();
}
