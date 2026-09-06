import { useEffect, useState } from "react";

export interface CellData {
  r: number; c: number; v?: string; rs?: number; cs?: number;
  b?: boolean; f?: string; bd?: Record<string, string>;
}

export interface SheetRender {
  sheet: string; max_row: number; max_col: number;
  cols: number[]; rows: number[];
  cells: CellData[]; shapes?: {text: string; t: number; l: number; w: number; h: number}[];
}

interface Props {
  documentId: string | null; version: string | null; sheet: string | null;
  highlights: {sheet: string; a1Range: string; type: string}[];
  zoom: number;
}

function colLetter(c: number): string {
  let s = "";
  c++;
  while (c > 0) { c--; s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26); }
  return s;
}

function parseA1(a1: string): {r: number; c: number} | null {
  const m = a1.match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let c = 0;
  for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
  return {r: parseInt(m[2]) - 1, c: c - 1};
}

export function JsonCellViewer({documentId, version, sheet, highlights, zoom}: Props) {
  const [data, setData] = useState<SheetRender | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!documentId || !sheet) return;
    let cancelled = false;
    fetch(`/api/viewer/documents/${encodeURIComponent(documentId)}/preview?document_version=${encodeURIComponent(version || "")}&sheet=${encodeURIComponent(sheet)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => { if (!cancelled) { setData(d); setError(null); } })
      .catch(e => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [documentId, version, sheet]);

  if (!documentId) return <div className="viewer-empty"><strong>Source를 선택하세요</strong><span>KG 근거 문서가 여기에 표시됩니다.</span></div>;
  if (error) return <div className="render-error">Preview를 표시할 수 없습니다. {error}</div>;
  if (!data) return <div className="viewer-empty"><span>로딩 중…</span></div>;

  // 셀 맵 구축
  const cellMap = new Map<string, CellData>();
  for (const cell of data.cells) cellMap.set(`${cell.r},${cell.c}`, cell);

  // 하이라이트 셀 집합
  const hlCells = new Set<string>();
  for (const h of highlights) {
    if (h.sheet !== sheet) continue;
    const p = parseA1(h.a1Range);
    if (p) hlCells.add(`${p.r},${p.c}`);
  }

  const defaultColW = 64, defaultRowH = 20;
  const colWidths = data.cols.length > 0 ? data.cols : Array(data.max_col).fill(defaultColW);
  const rowHeights = data.rows.length > 0 ? data.rows : Array(data.max_row).fill(defaultRowH);

  // 병합 셀 추적 (스팬한 셀은 스킵)
  const spanned = new Set<string>();
  for (const cell of data.cells) {
    if ((cell.rs || 1) > 1 || (cell.cs || 1) > 1) {
      for (let dr = 0; dr < (cell.rs || 1); dr++)
        for (let dc = 0; dc < (cell.cs || 1); dc++)
          if (dr > 0 || dc > 0) spanned.add(`${cell.r + dr},${cell.c + dc}`);
    }
  }

  return (
    <div className="json-sheet" style={{overflow: "auto", transform: `scale(${zoom})`, transformOrigin: "top left"}}>
      <table style={{borderCollapse: "collapse", tableLayout: "fixed"}}>
        <colgroup>
          <col style={{width: 36}} />
          {colWidths.slice(0, data.max_col).map((w, i) => <col key={i} style={{width: w}} />)}
        </colgroup>
        <tbody>
          {Array.from({length: data.max_row}, (_, ri) => (
            <tr key={ri} style={{height: (rowHeights[ri] || defaultRowH)}}>
              <td className="row-num" style={{textAlign: "center", background: "#f5f5f5", color: "#888", fontSize: 11, border: "1px solid #ddd"}}>{ri + 1}</td>
              {Array.from({length: data.max_col}, (_, ci) => {
                const key = `${ri},${ci}`;
                if (spanned.has(key)) return <td key={ci} style={{border: "1px solid #e0e0e0", padding: 0}} />;
                const cell = cellMap.get(key);
                const isHL = hlCells.has(key);
                const style: React.CSSProperties = {
                  border: "1px solid #e0e0e0", padding: "2px 4px", fontSize: 12,
                  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  fontWeight: cell?.b ? "bold" : undefined,
                  background: isHL ? "#e8f5e9" : (cell?.f || undefined),
                };
                if (cell?.rs && cell.rs > 1) style.borderBottom = "none";
                if (cell?.cs && cell.cs > 1) style.borderRight = "none";
                return <td key={ci} rowSpan={cell?.rs || 1} colSpan={cell?.cs || 1} style={style}>{cell?.v || ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {data.shapes?.map((s, i) => (
        <div key={i} style={{position: "absolute", top: s.t, left: s.l, width: s.w, height: s.h,
          background: "#fffde7", border: "1px solid #f9a825", padding: 2, fontSize: 11, overflow: "hidden"}}>
          {s.text}
        </div>
      ))}
    </div>
  );
}
