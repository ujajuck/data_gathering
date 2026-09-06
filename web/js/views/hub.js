import { api, el, fmt } from '../api.js';
import { statusPill } from '../components/chips.js';
import { dataTable } from '../components/data-table.js';

export function lotDetailPanel(detail) {
  const conceptRows = Object.entries(detail.concepts).map(([cid, vals]) =>
    el('tr', {},
      el('td', { class: 'mono' }, cid),
      el('td', {}, vals.slice(0, 4).map(v => el('span', { class: 'src' },
        `${fmt(v.value)}`, el('i', {}, v.unit || ''),
        el('small', {}, v.source))))));
  return el('div', {},
    el('h3', {}, `${detail.lot} — 문서 횡단 통합`,
      ' ', el('span', { class: 'pill neutral' },
        `${detail.records.length} 레코드 · ${detail.documents.length} 시트 · ${Object.keys(detail.concepts).length} 개념`)),
    el('p', { class: 'dim' }, `출처: ${detail.documents.join(' · ')}`),
    el('div', { class: 'tblwrap' }, el('table', {},
      el('thead', {}, el('tr', {}, el('th', {}, '레코드'), el('th', {}, '시각'), el('th', {}, '판정'))),
      el('tbody', {}, detail.records.map(r => el('tr', {},
        el('td', { class: 'mono' }, r.record_key),
        el('td', { class: 'mono dim' }, r.event_time || '—'),
        el('td', {}, statusPill(r.overall_status))))))),
    el('details', { class: 'drawer', open: '' },
      el('summary', {}, '개념별 통합 값 (출처 셀 포함)'),
      el('div', { class: 'tblwrap' }, el('table', {}, el('tbody', {}, conceptRows)))));
}

export default async function hub(root) {
  const detailPanel = el('div', { class: 'panel' },
    el('p', { class: 'empty' }, 'LOT를 선택하면 문서 횡단 통합 상세가 표시됩니다'));

  const table = dataTable({
    fetchPage: (page, size) => api(`/api/lots?page=${page}&size=${size}`),
    pageSize: 25,
    onRow: async (row) => {
      const detail = await api(`/api/lots/${encodeURIComponent(row.lot)}`);
      detailPanel.replaceChildren(lotDetailPanel(detail));
    },
    columns: [
      { key: 'lot', label: 'LOT/설비', render: r => el('b', { class: 'mono' }, r.lot) },
      { key: 'record_count', label: '레코드', cls: 'num' },
      { key: 'sheet_count', label: '시트', cls: 'num' },
      { key: 'concept_count', label: '개념', cls: 'num' },
      { key: 'statuses', label: '판정',
        render: r => el('span', {}, r.statuses.length
          ? r.statuses.map(s => statusPill(s)) : [statusPill(null)]) },
    ],
  });

  root.append(el('div', { class: 'grid2' },
    el('div', { class: 'panel' }, el('h3', {}, 'LOT 허브 — business key 조인'), table.el),
    detailPanel));
}
