// Lineage 흐름도 — 원본 셀 N개 → 표준 개념 → 통합 저장 값
import { esc, fmt } from '../api.js';

export function renderLineage(container, { conceptName, conceptId, unit, items }) {
  const n = items.length;
  if (!n) { container.innerHTML = '<p class="empty">해당 조건의 관측치가 없습니다</p>'; return; }
  const H = Math.max(300, 96 * n + 40);
  const midY = H / 2;
  const parts = [];
  items.forEach((o, i) => {
    const y = 60 + i * 96;
    const raw = o.raw_value_num ?? o.raw_value_text ?? '';
    const conv = !o.raw_unit || o.raw_unit === unit || String(o.raw_unit).startsWith(String(unit))
      ? '동일' : `${unit} ← ${o.raw_unit} 변환`;
    parts.push(
      `<rect x="16" y="${y - 34}" width="262" height="68" rx="6" class="lbox"/>`,
      `<text x="30" y="${y - 12}" class="lt b">${esc(o.source_sheet)}!${esc(o.source_address)}</text>`,
      `<text x="30" y="${y + 8}" class="lt mono">${esc(fmt(raw))} ${esc(o.raw_unit || '')}</text>`,
      `<text x="30" y="${y + 26}" class="lt dim2">${esc(conv)}</text>`,
      `<line x1="278" y1="${y}" x2="424" y2="${midY}" class="kge" marker-end="url(#linarr)"/>`);
  });
  const values = [...new Set(items.map(o =>
    fmt(o.normalized_value_num ?? o.normalized_value_text ?? '')))];
  const std = values.length === 1 ? values[0] : `${values.length}개 값`;
  container.innerHTML = `<figure>
    <svg viewBox="0 0 900 ${H}" role="img" aria-label="${esc(conceptName)} lineage — 원본 표현이 표준값으로 수렴">
      <defs><marker id="linarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7"
        markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
      ${parts.join('')}
      <rect x="432" y="${midY - 38}" width="180" height="76" rx="38" class="cbig"/>
      <text x="522" y="${midY - 5}" class="lab big">${esc(conceptName)}${unit ? ` (${esc(unit)})` : ''}</text>
      <text x="522" y="${midY + 15}" class="cnt">${esc(conceptId)}</text>
      <line x1="612" y1="${midY}" x2="710" y2="${midY}" class="kge" marker-end="url(#linarr)"/>
      <rect x="718" y="${midY - 34}" width="168" height="68" rx="6" class="rbox"/>
      <text x="802" y="${midY - 5}" class="lab big mono">${esc(std)}${values.length === 1 && unit ? ` ${esc(unit)}` : ''}</text>
      <text x="802" y="${midY + 17}" class="cnt">표준값 · 출처 ${n}개 셀 보존</text>
    </svg>
  </figure>`;
}
