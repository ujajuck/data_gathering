// 지식 그래프 SVG 렌더러 — /api/graph 데이터 주입형.
// 알려진 레이아웃(화학공정 시안)이 전부 매칭될 때만 고정 좌표를 쓰고,
// 그 외 도메인은 허브(엣지 차수 최대) 중심 원형 자동 배치로 그린다.
import { esc } from '../api.js';

const PRESET = {
  run: [300, 90], equipment: [640, 90], lot: [470, 265],
  input: [110, 265], output: [830, 220], quality: [170, 430],
  energy: [760, 400], time: [470, 480], document: [900, 500],
};
const PRESET_R = { lot: 64, document: 38 };
const LABEL_T = {
  'energy|used_by': 0.22, 'equipment|consumes': 0.74,
  'output|produced_by': 0.28, 'run|produces': 0.42, 'lot|belongs_to': 0.62,
};

function layout(data) {
  const classes = data.nodes.map(n => n.class);
  if (classes.every(c => PRESET[c])) {
    return { pos: PRESET, radii: PRESET_R, hub: 'lot' };
  }
  // 자동 배치: 엣지 차수가 가장 큰 클래스를 중심에, 나머지는 원형으로
  const degree = Object.fromEntries(classes.map(c => [c, 0]));
  for (const e of data.edges) {
    if (e.subject in degree) degree[e.subject] += 1;
    if (e.object in degree) degree[e.object] += 1;
  }
  const hub = classes.slice().sort((a, b) => degree[b] - degree[a])[0];
  const ring = classes.filter(c => c !== hub);
  const cx = 490, cy = 275, R = 195;
  const pos = { [hub]: [cx, cy] };
  ring.forEach((c, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / ring.length;
    pos[c] = [Math.round(cx + R * Math.cos(a) * 1.55), Math.round(cy + R * Math.sin(a))];
  });
  return { pos, radii: { [hub]: 64 }, hub };
}

export function renderGraph(container, data) {
  const nodes = Object.fromEntries(data.nodes.map(n => [n.class, n]));
  const { pos: POS, radii: R, hub } = layout(data);
  const parts = [];
  for (const e of data.edges) {
    if (!POS[e.subject] || !POS[e.object]) continue;
    const [x1, y1] = POS[e.subject]; const [x2, y2] = POS[e.object];
    const r1 = R[e.subject] || 52; const r2 = R[e.object] || 52;
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
    const sx = x1 + dx / L * (r1 + 4), sy = y1 + dy / L * (r1 + 4);
    const ex = x2 - dx / L * (r2 + 9), ey = y2 - dy / L * (r2 + 9);
    const t = LABEL_T[`${e.subject}|${e.predicate}`] ?? 0.5;
    const mx = sx + (ex - sx) * t, my = sy + (ey - sy) * t + (Math.abs(dy) > Math.abs(dx) ? -8 : -7);
    parts.push(`<line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" class="kge" marker-end="url(#kgarr)"/>`,
      `<text x="${mx}" y="${my}" class="elab">${esc(e.name_ko)} ·${Number(e.evidence_records) || 0}</text>`);
  }
  for (const [cls, [x, y]] of Object.entries(POS)) {
    const n = nodes[cls];
    if (!n) continue;
    const r = R[cls] || 52;
    const onacc = cls === hub ? ' onacc' : '';
    parts.push(`<circle cx="${x}" cy="${y}" r="${r}" class="kgn${cls === hub ? ' kg-lot' : ''}"/>`,
      `<text x="${x}" y="${y - 6}" class="lab${onacc}">${esc(n.name_ko)}</text>`,
      `<text x="${x}" y="${y + 13}" class="cnt${onacc}">${n.observation_count.toLocaleString()}건</text>`);
    if (cls === hub && n.instances.length) {
      parts.push(`<text x="${x}" y="${y + 34}" class="sub">예: ${esc(n.instances[0])}</text>`);
    }
  }
  container.innerHTML = `<figure>
    <svg viewBox="0 0 980 560" role="img" aria-label="엔티티 클래스 지식 그래프">
      <defs><marker id="kgarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7"
        markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
      ${parts.join('')}
    </svg>
    <figcaption>엣지의 숫자는 두 엔티티가 같은 레코드에 동시 등장한 횟수(근거 레코드 수), 노드의 건수는 해당 클래스로 분류된 관측치 수.</figcaption>
  </figure>`;
}
