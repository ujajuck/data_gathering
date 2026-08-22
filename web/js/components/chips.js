import { el } from '../api.js';

export const chip = (text, opts = {}) => {
  const c = el('span', { class: `chip${opts.sm ? ' sm' : ''}` }, text);
  if (opts.child) c.dataset.child = '1';
  if (opts.unit) c.append(el('span', { class: 'u' }, opts.unit));
  return c;
};

const BAD = new Set(['NG', 'HOLD', 'EXC', 'C', '재검/부적합', '정비 필요', '이상', 'rejected']);
const OK = new Set(['OK', 'PASS', 'CLOSED', 'P', '합격', '정상', 'approved', 'SUCCESS']);

export const statusPill = (s) => {
  if (s === null || s === undefined || s === '') return el('span', { class: 'dim' }, '—');
  const cls = BAD.has(s) ? 'bad' : OK.has(s) ? 'ok' : 'neutral';
  return el('span', { class: `pill ${cls}` }, s);
};

export const rolePill = (role) => el('span', {
  class: `pill ${role === 'result' ? 'warn' : role === 'calculated' ? 'neutral' : 'ok'}`,
}, role);
