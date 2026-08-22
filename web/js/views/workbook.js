import { api, el, fmt } from '../api.js';
import { rolePill, statusPill } from '../components/chips.js';
import { dataTable } from '../components/data-table.js';

export default async function workbook(root) {
  const sheets = await api('/api/sheets');
  const sheetSel = el('select', {},
    el('option', { value: '' }, '모든 시트'),
    sheets.items.map(s => el('option', { value: s }, s)));
  const lotInput = el('input', { placeholder: 'LOT (정확히)', size: '12' });
  const qInput = el('input', { placeholder: '레코드 키 검색', size: '18' });

  const detail = el('div', { class: 'panel' },
    el('p', { class: 'empty' }, '레코드를 선택하면 관측치가 표시됩니다'));

  const table = dataTable({
    pageSize: 25,
    fetchPage: (page, size) => {
      const p = new URLSearchParams({ page, size });
      if (sheetSel.value) p.set('sheet', sheetSel.value);
      if (lotInput.value.trim()) p.set('lot', lotInput.value.trim());
      if (qInput.value.trim()) p.set('q', qInput.value.trim());
      return api(`/api/records?${p}`);
    },
    onRow: async (row) => {
      const d = await api(`/api/records/${encodeURIComponent(row.record_key)}/detail`);
      detail.replaceChildren(
        el('h3', {}, row.record_key),
        el('dl', { class: 'kv' },
          el('dt', {}, 'record_type'), el('dd', {}, d.record_type),
          el('dt', {}, 'event_time'), el('dd', {}, d.event_time || '—'),
          el('dt', {}, 'semantic_hash'), el('dd', {}, d.semantic_hash.slice(0, 16)),
          el('dt', {}, 'version'), el('dd', {}, String(d.version))),
        el('div', { class: 'tblwrap', style: 'margin-top:12px' }, el('table', {},
          el('thead', {}, el('tr', {},
            el('th', {}, '개념'), el('th', {}, '라벨'), el('th', {}, '값'),
            el('th', {}, '역할'), el('th', {}, '셀'))),
          el('tbody', {}, d.observations.map(o => el('tr', {},
            el('td', { class: 'mono' }, o.concept_id ||
              el('span', { class: 'pill warn' }, 'pending')),
            el('td', {}, `${o.raw_label || ''}${o.row_key ? ` [${o.row_key}]` : ''}`),
            el('td', { class: 'num' },
              `${fmt(o.normalized_value_num ?? o.normalized_value_text ?? '')} ${o.canonical_unit || ''}`),
            el('td', {}, rolePill(o.value_role)),
            el('td', { class: 'mono dim' }, o.source_address)))))));
    },
    columns: [
      { key: 'record_key', label: '레코드 키', render: r => el('span', { class: 'mono' }, r.record_key) },
      { key: 'business_key', label: 'Key', cls: 'mono' },
      { key: 'event_time', label: '시각', cls: 'mono dim' },
      { key: 'overall_status', label: '판정', render: r => statusPill(r.overall_status) },
      { key: 'version', label: 'v', cls: 'num' },
    ],
  });

  const reload = () => table.reload();
  sheetSel.addEventListener('change', reload);
  for (const inp of [lotInput, qInput]) {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') reload(); });
  }

  root.append(el('div', { class: 'grid2' },
    el('div', { class: 'panel' },
      el('div', { class: 'toolbar' }, sheetSel, lotInput, qInput,
        el('button', { class: 'act', onclick: reload }, '검색')),
      table.el),
    detail));
}
