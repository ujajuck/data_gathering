// fetch 래퍼: ETag 캐시 + 오류 토스트 + 쿼리 헬퍼 (WEB_PLAN §2)
const etagCache = new Map(); // url -> {etag, data}

export function qs(params) {
  const p = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return p.length ? `?${p.join('&')}` : '';
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const cached = etagCache.get(path);
  if (!options.method && cached) headers['If-None-Match'] = cached.etag;
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (e) {
    toast(`서버에 연결할 수 없습니다 — ${e.message}`, true);
    throw e;
  }
  if (res.status === 304 && cached) return cached.data;
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* ignore */ }
    toast(`요청 실패 (${res.status}) — ${detail}`, true);
    throw new Error(detail);
  }
  const data = await res.json();
  const etag = res.headers.get('ETag');
  if (etag && !options.method) etagCache.set(path, { etag, data });
  return data;
}

export function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

export function fmt(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const s = Math.round(v * 10000) / 10000;
    return s.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return String(v);
}

// innerHTML 템플릿에 삽입되는 모든 동적 문자열은 이 함수를 거친다 (저장형 XSS 차단)
export function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
};
