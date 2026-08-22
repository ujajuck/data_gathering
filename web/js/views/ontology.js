import { api, el } from '../api.js';
import { chip } from '../components/chips.js';

export default async function ontology(root) {
  const data = await api('/api/ontology');
  const grid = el('div', { class: 'domgrid' });
  for (const d of Object.values(data.domains)) {
    if (!d.concepts.length) continue;
    grid.append(el('div', { class: 'dom' },
      el('h4', {}, d.name_ko, ' ', el('em', {}, d.name_en), el('b', {}, String(d.concepts.length))),
      el('div', { class: 'chips' }, d.concepts.map(c =>
        chip(c.name_ko, { child: !!c.parent_concept, unit: c.canonical_unit || undefined })))));
  }
  root.append(el('div', { class: 'panel' }, grid));
}
