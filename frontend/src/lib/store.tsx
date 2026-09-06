// 4개 탭이 공유하는 전역 상태 — web_kg app.js의 state 객체에 대응한다.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, PALETTE, readCart, writeCart } from "./api";
import type { CartItem } from "./api";
import type { Concept, DkgSummary, DomainKg, FileRow, SearchResult } from "./types";

export type Screen = "files" | "kg" | "source" | "db" | "templates";
export interface SelNode { id: string; name: string; root: string | null }
export interface SrcRequest { doc: string; sheet: string | null; node: string | null; seq: number }

export interface Store {
  ready: boolean;
  initError: string | null;
  domain: DomainKg | null;
  dkgs: DkgSummary[];
  concepts: Concept[];
  files: FileRow[];
  kgVersion: number;                    // reloadKg마다 증가 — 파생 캐시 무효화 신호

  screen: Screen;
  show: (s: Screen) => void;

  selNode: SelNode | null;
  setSelNode: (n: SelNode | null) => void;
  selDkg: string | null;
  setSelDkg: (id: string | null) => void;
  selDkgDoc: string | null;
  setSelDkgDoc: (id: string | null) => void;
  reviewDoc: string | null;
  setReviewDoc: (id: string | null) => void;

  nodeSearch: SearchResult | null;
  setNodeSearch: (r: SearchResult | null) => void;

  overlayEnabled: boolean;
  setOverlayEnabled: (v: boolean) => void;

  cartCount: number;
  cartRev: number;               // 내용만 바뀌는 갱신(raw 플래그 등)도 리렌더 유발
  cartItems: () => CartItem[];
  addCart: (items: CartItem | CartItem[]) => void;
  saveCart: (items: CartItem[]) => void;

  reloadKg: () => Promise<void>;
  loadFiles: () => Promise<void>;
  dkgOf: (id: string) => DkgSummary | undefined;
  dkgColor: (id: string) => string;

  srcRequest: SrcRequest | null;
  requestSheet: (doc: string, sheet: string | null, node: string | null) => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("StoreProvider missing");
  return s;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [domain, setDomain] = useState<DomainKg | null>(null);
  const [dkgs, setDkgs] = useState<DkgSummary[]>([]);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [kgVersion, setKgVersion] = useState(0);

  const [screen, setScreen] = useState<Screen>("kg");
  const [selNode, setSelNode] = useState<SelNode | null>(null);
  const [selDkg, setSelDkg] = useState<string | null>(null);
  const [selDkgDoc, setSelDkgDoc] = useState<string | null>(null);
  const [reviewDoc, setReviewDoc] = useState<string | null>(null);
  const [nodeSearch, setNodeSearch] = useState<SearchResult | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const [cartCount, setCartCount] = useState(() => readCart().length);
  const [cartRev, setCartRev] = useState(0);
  const [srcRequest, setSrcRequest] = useState<SrcRequest | null>(null);
  const srcSeq = useRef(0);

  const reloadKg = useCallback(async () => {
    const [dom, groups, cons] = await Promise.all([
      api("/api/kg/domain"), api("/api/kg/document"), api("/api/concepts")]);
    setDomain(dom);
    setDkgs(groups);
    setConcepts(cons);
    setSelDkg((cur) => (cur && !groups.some((g: DkgSummary) => g.id === cur) ? null : cur));
    setNodeSearch(null);
    setKgVersion((v) => v + 1);
  }, []);

  const loadFiles = useCallback(async () => {
    setFiles(await api("/api/files"));
  }, []);

  useEffect(() => {
    reloadKg().then(() => setReady(true))
      .catch((e) => setInitError(e.message));
    loadFiles().catch(() => {});
  }, [reloadKg, loadFiles]);

  const cartItems = useCallback(() => readCart(), []);
  const saveCart = useCallback((items: CartItem[]) => {
    writeCart(items);
    setCartCount(items.length);
    setCartRev((v) => v + 1);
  }, []);
  const addCart = useCallback((items: CartItem | CartItem[]) => {
    const c = readCart();
    for (const it of ([] as CartItem[]).concat(items))
      if (!c.some((x) => x.node_id === it.node_id)) c.push(it);
    writeCart(c);
    setCartCount(c.length);
    setCartRev((v) => v + 1);
  }, []);

  const dkgOf = useCallback((id: string) => dkgs.find((g) => g.id === id), [dkgs]);
  const dkgColor = useCallback(
    (id: string) => PALETTE[Math.max(0, dkgs.findIndex((g) => g.id === id)) % PALETTE.length],
    [dkgs]);

  const requestSheet = useCallback((doc: string, sheet: string | null, node: string | null) => {
    setSrcRequest({ doc, sheet, node, seq: ++srcSeq.current });
  }, []);

  const store: Store = {
    ready, initError, domain, dkgs, concepts, files, kgVersion,
    screen, show: setScreen,
    selNode, setSelNode, selDkg, setSelDkg, selDkgDoc, setSelDkgDoc,
    reviewDoc, setReviewDoc,
    nodeSearch, setNodeSearch,
    overlayEnabled, setOverlayEnabled,
    cartCount, cartRev, cartItems, addCart, saveCart,
    reloadKg, loadFiles, dkgOf, dkgColor,
    srcRequest, requestSheet,
  };
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
