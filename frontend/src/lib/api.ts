// web_kg(app.js)와 동일한 REST API를 쓰는 헬퍼 — 백엔드 무변경 원칙.
export async function api(path: string, opts?: RequestInit): Promise<any> {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error((await r.text()).slice(0, 300));
  return r.json();
}

export const post = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });

export const del = (path: string) => api(path, { method: "DELETE" });

export const patch = (path: string, body: unknown) =>
  api(path, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });

export const PALETTE = ["#3569e8", "#7b61c9", "#3a8d6d", "#b57b1b", "#c05b8c", "#3d8ea6", "#7a7f8a"];
export const ROLE_BADGE: Record<string, string> = { KEY: "green", VALUE: "blue", CONTEXT: "amber", IGNORE: "" };

export function colName(n: number): string {
  let s = "";
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export interface CellRange { r1: number; c1: number; r2: number; c2: number }
export function parseRange(range: string | null | undefined): CellRange | null {
  const one = (a: string | undefined) => {
    const m = /^([A-Z]+)(\d+)$/.exec((a || "").trim());
    if (!m) return null;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    return { c, r: +m[2] };
  };
  const [a, b] = String(range || "").split(":");
  const p1 = one(a), p2 = one(b || a);
  return p1 && p2 ? { r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c),
                      r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) } : null;
}

// -------------------------------------------------- 통합 초안 (Selection Basket)
// web_kg와 같은 localStorage 키를 공유 — 두 프런트를 오가도 묶음이 유지된다.
export const CART_KEY = "kg_cart_v3";
export interface CartItem {
  node_id: string; concept_id: string | null; header: string;
  document: string; sheet: string; range: string; role: string | null;
  raw?: boolean;    // 양식별 전처리 '원값 유지' — 빌드 시 단위 변환 생략
}
export function readCart(): CartItem[] {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || "") || []; } catch { return []; }
}
export function writeCart(c: CartItem[]): void {
  try { localStorage.setItem(CART_KEY, JSON.stringify(c)); } catch { /* 저장 불가 환경 무시 */ }
}
