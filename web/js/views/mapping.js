import { api, post, toast, el } from '../api.js';
import { chip } from '../components/chips.js';
import { dataTable } from '../components/data-table.js';

export default async function mapping(root) {
  const docs = await api('/api/documents');
  const docRows = docs.items.map(d => el('tr', {},
    el('td', {}, el('b', {}, d.logical_name),
      el('small', { class: 'dim', style: 'display:block' },
        `시트 ${d.sheet_count} · 레코드 ${d.record_count} · 버전 ${d.versions}`)),
    el('td', { class: 'num' }, String(d.concept_count)),
    el('td', { class: 'num' }, d.pending_mappings
      ? el('span', { class: 'pill warn' }, String(d.pending_mappings)) : '0'),
    el('td', {}, el('div', { class: 'chips' }, [
      ...d.concepts.slice(0, 8).map(c => chip(c, { sm: true })),
      d.concepts.length > 8 ? chip(`+${d.concepts.length - 8}`, { sm: true }) : null,
    ]))));

  const pendingPanel = el('div', { class: 'panel' });

  function renderPending() {
    pendingPanel.replaceChildren(el('h3', {}, '검토 대기 매핑 — 승인 시 동의어 사전으로 승격 (§5)'));
    const table = dataTable({
      pageSize: 20,
      fetchPage: (page, size) => api(`/api/mapping/pending?page=${page}&size=${size}`),
      emptyText: '검토 대기 항목이 없습니다 🎉',
      columns: [
        { key: 'raw_label', label: '원본 라벨', render: r => el('b', {}, r.raw_label || '') },
        { key: 'context', label: '문맥', cls: 'dim',
          render: r => (r.context || '').split('/').slice(0, 3).join(' / ') },
        { key: 'concept_id', label: '후보 개념', render: r => r.concept_id
            ? el('span', { class: 'mono' }, r.concept_id) : el('span', { class: 'dim' }, '후보 없음') },
        { key: 'confidence', label: '신뢰도', cls: 'num',
          render: r => (r.confidence ?? 0).toFixed(2) },
        { key: '_act', label: '결정', render: r => {
            // 진행 중 이중 제출 방지: 두 버튼 모두 잠갔다가 실패 시에만 복구
            const decide = async (e, action) => {
              e.stopPropagation();
              const row = e.target.closest('span');
              const buttons = row.querySelectorAll('button');
              buttons.forEach(b => { b.disabled = true; });
              try {
                const res = await post('/api/mapping/decisions',
                  { field_signature: r.field_signature, action });
                toast(action === 'approve'
                  ? (res.synonym_promoted
                      ? `승인 — '${r.raw_label}' 동의어 승격, 사전 버전 상승` : '승인되었습니다')
                  : '보류(반려) 처리되었습니다');
                renderPending();
              } catch {
                buttons.forEach(b => { b.disabled = false; });
              }
            };
            return el('span', {},
              el('button', { class: 'act ok', disabled: r.concept_id ? undefined : 'disabled',
                             onclick: e => decide(e, 'approve') }, '승인'),
              ' ',
              el('button', { class: 'act bad', onclick: e => decide(e, 'reject') }, '반려'));
          } },
      ],
    });
    pendingPanel.append(table.el);
  }

  root.append(
    el('div', { class: 'panel' },
      el('h3', {}, '문서 → 표준 개념 연결'),
      el('div', { class: 'tblwrap' }, el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '문서'), el('th', {}, '개념'), el('th', {}, '대기'), el('th', {}, '연결된 개념'))),
        el('tbody', {}, docRows)))),
    pendingPanel);
  renderPending();
}
