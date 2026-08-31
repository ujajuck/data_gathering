// 원본 충실 렌더: 열폭/행고/병합/테두리/폰트/정렬/이미지를 그대로 재현 (§10.1)
// + Semantic Overlay(역할 테두리)와 포커스 셀 하이라이트. web_kg loadSheet 렌더부 포트.
import { useEffect, useRef } from "react";
import { colName, parseRange } from "../../lib/api";
import type { OverlayItem, SheetCell, SheetData } from "../../lib/types";

const HDRW = 34, HDRH = 22;
const ALIGN: Record<string, string> = { l: "left", c: "center", r: "right" };

interface Props {
  data: SheetData;
  overlay: OverlayItem[];    // overlayEnabled에 따라 걸러진 목록
  focusNode: string | null;
  onCellClick: (nodeId: string) => void;
}

export default function SheetGrid({ data, overlay, focusNode, onCellClick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = wrapRef.current?.querySelector("td.selc");
    if (el) el.scrollIntoView({ block: "center", inline: "center" });
  }, [data, focusNode]);

  const ovAt = new Map<string, OverlayItem>();
  for (const o of overlay) {
    const rg = parseRange(o.range);
    if (rg) {
      for (let r = rg.r1; r <= rg.r2; r++)
        for (let c = rg.c1; c <= rg.c2; c++)
          if (!ovAt.has(`${r},${c}`)) ovAt.set(`${r},${c}`, o);
    } else if (o.header) {
      // range 없으면 node_name으로 셀 찾기
      const hdr = o.header.trim();
      for (const c of data.cells) {
        if (c.v && c.v.trim() === hdr && !ovAt.has(`${c.r},${c.c}`)) {
          ovAt.set(`${c.r},${c.c}`, o);
          break;
        }
      }
    }
  }
  const focus = focusNode ? overlay.find((o) => o.node_id === focusNode) : null;
  const focusRange = focus ? parseRange(focus.range) : null;

  const byPos = new Map<string, SheetCell>();
  for (const c of data.cells) byPos.set(`${c.r},${c.c}`, c);
  const covered = new Set<string>();
  for (const c of data.cells)
    for (let r = c.r; r < c.r + (c.rs || 1); r++)
      for (let k = c.c; k < c.c + (c.cs || 1); k++)
        if (r !== c.r || k !== c.c) covered.add(`${r},${k}`);

  const grid = data.gridlines ? "1px solid #e9edf2" : "1px solid transparent";

  const cellTd = (r: number, c: number) => {
    if (covered.has(`${r},${c}`)) return null;
    const cell = byPos.get(`${r},${c}`);
    const ov = ovAt.get(`${r},${c}`);
    const inFocus = focusRange && r >= focusRange.r1 && r <= focusRange.r2 &&
      c >= focusRange.c1 && c <= focusRange.c2;
    const cls = ((ov && ov.role !== "IGNORE" ? ` ov ov-${ov.role}` : (ov ? " ov" : "")) +
      (inFocus ? " selc" : "")).trim();
    const st: React.CSSProperties = { border: grid };
    if (cell) {
      if (cell.f) st.background = cell.f;
      if (cell.b) st.fontWeight = 700;
      if (cell.i) st.fontStyle = "italic";
      if (cell.sz) st.fontSize = `${cell.sz}px`;
      if (cell.fc) st.color = cell.fc;
      if (cell.ha) st.textAlign = ALIGN[cell.ha] as React.CSSProperties["textAlign"];
      else if (cell.n) st.textAlign = "right";
      if (cell.wr) { st.whiteSpace = "normal"; st.wordBreak = "break-all"; }
      if (cell.bd) {
        if (cell.bd.t) st.borderTop = cell.bd.t;
        if (cell.bd.r) st.borderRight = cell.bd.r;
        if (cell.bd.b) st.borderBottom = cell.bd.b;
        if (cell.bd.l) st.borderLeft = cell.bd.l;
      }
    }
    return (
      <td key={c} className={cls || undefined} style={st}
        rowSpan={cell?.rs || undefined} colSpan={cell?.cs || undefined}
        title={`${colName(c)}${r}${ov ? ` · ${ov.concept_name || ov.header} [${ov.role}]` : ""}`}
        onClick={ov ? () => onCellClick(ov.node_id) : undefined}>
        {cell ? cell.v : ""}
      </td>
    );
  };

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
      <table className="grid" style={{ tableLayout: "fixed", borderCollapse: "collapse" }}>
        <colgroup>
          <col style={{ width: HDRW }} />
          {data.cols.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <tbody>
          <tr style={{ height: HDRH }}>
            <td className="hd"></td>
            {Array.from({ length: data.max_col }, (_, i) => (
              <td key={i} className="hd">{colName(i + 1)}</td>
            ))}
          </tr>
          {Array.from({ length: data.max_row }, (_, ri) => {
            const r = ri + 1;
            return (
              <tr key={r} style={{ height: data.rows[ri] }}>
                <td className="hd">{r}</td>
                {Array.from({ length: data.max_col }, (_, ci) => cellTd(r, ci + 1))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* 이미지 오버레이 — 앵커 px 좌표에 절대 배치 (원본 도형/사진 보존) */}
      {(data.images || []).map((im, i) => (
        <img key={i} src={im.src} alt="" style={{ position: "absolute",
          left: HDRW + im.x, top: HDRH + im.y, width: im.w, height: im.h,
          boxShadow: "0 1px 4px rgba(20,30,50,.18)", pointerEvents: "none" }} />
      ))}
      {/* Shape/TextBox 오버레이 — DRM 파일의 텍스트박스 표시 */}
      {(data.shapes || []).map((sh, i) => (
        <div key={i} style={{ position: "absolute",
          left: HDRW + (sh.left || 0) / 7, top: HDRH + (sh.top || 0) / 1.33,
          width: (sh.width || 100) / 7, height: (sh.height || 30) / 1.33,
          fontSize: 11, whiteSpace: "pre-wrap", overflow: "hidden",
          background: "rgba(255,255,230,.85)", border: "1px solid #ccc", borderRadius: 2,
          padding: "2px 4px", pointerEvents: "none", zIndex: 2 }}>
          {sh.text || ""}
        </div>
      ))}
    </div>
  );
}
