// 서버 페이지네이션 테이블 — DOM을 반환하는 순수 함수 컴포넌트 (재사용, WEB_PLAN §2)
import { el } from '../api.js';

/**
 * @param {Object} cfg
 * @param {{key:string,label:string,render?:Function,cls?:string}[]} cfg.columns
 * @param {(page:number,size:number)=>Promise<{items:any[],total:number}>} cfg.fetchPage
 * @param {number} [cfg.pageSize]
 * @param {(row:any, tr:HTMLElement)=>void} [cfg.onRow]  행 클릭 핸들러
 */
export function dataTable({ columns, fetchPage, pageSize = 50, onRow, emptyText = '데이터가 없습니다' }) {
  let page = 1;
  const thead = el('thead', {}, el('tr', {}, columns.map(c => el('th', {}, c.label))));
  const tbody = el('tbody');
  const info = el('span');
  const prev = el('button', { onclick: () => { page -= 1; load(); } }, '이전');
  const next = el('button', { onclick: () => { page += 1; load(); } }, '다음');
  const root = el('div', {},
    el('div', { class: 'tblwrap' }, el('table', {}, thead, tbody)),
    el('div', { class: 'pager' }, prev, info, next));

  let seq = 0;   // out-of-order 응답 가드: 최신 요청만 화면에 반영
  async function load() {
    const my = ++seq;
    prev.disabled = next.disabled = true;
    let items, total;
    try {
      ({ items, total } = await fetchPage(page, pageSize));
    } catch (e) {
      if (my === seq) { prev.disabled = page <= 1; next.disabled = false; }
      throw e;
    }
    if (my !== seq) return;
    tbody.replaceChildren();
    if (!items.length) {
      tbody.append(el('tr', {}, el('td', { colspan: String(columns.length), class: 'empty' }, emptyText)));
    }
    for (const row of items) {
      const tr = el('tr', onRow ? { class: 'clickable', tabindex: '0' } : {},
        columns.map(c => {
          const td = el('td', { class: c.cls || '' });
          const v = c.render ? c.render(row) : row[c.key];
          if (v !== null && v !== undefined) td.append(v.nodeType ? v : String(v));
          return td;
        }));
      if (onRow) {
        const activate = () => {
          tbody.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected'));
          tr.classList.add('selected');
          onRow(row, tr);
        };
        tr.addEventListener('click', activate);
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') activate(); });
      }
      tbody.append(tr);
    }
    const pages = Math.max(1, Math.ceil(total / pageSize));
    info.textContent = `${page} / ${pages} 페이지 · 총 ${total.toLocaleString()}건`;
    prev.disabled = page <= 1;
    next.disabled = page >= pages;
  }

  load();
  return { el: root, reload: () => { page = 1; load(); }, refresh: load };
}
