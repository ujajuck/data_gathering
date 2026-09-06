import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PdfViewerState } from "./LibreOfficePdfViewerAdapter";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfWorkbookViewer({state}: {state: PdfViewerState}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!state.documentId || !state.version || !canvas.current) return;
    let cancelled = false;
    const url = `/api/viewer/documents/${encodeURIComponent(state.documentId)}/preview?document_version=${encodeURIComponent(state.version)}`;
    pdfjs.getDocument(url).promise.then(async pdf => {
      const page = await pdf.getPage(1); // sheet navigation remains logical metadata in Phase 1
      const viewport = page.getViewport({scale: state.zoom});
      const target = canvas.current!; target.width = viewport.width; target.height = viewport.height;
      if (!cancelled) await page.render({canvas: target, canvasContext: target.getContext("2d")!, viewport}).promise;
    }).catch(e => !cancelled && setError(String(e)));
    return () => { cancelled = true; };
  }, [state.documentId, state.version, state.zoom]);
  if (!state.documentId) return <div className="viewer-empty"><strong>Source를 선택하세요</strong><span>KG 근거 문서가 여기에 표시됩니다.</span></div>;
  return <div className="pdf-stage">
    {error && <div className="render-error">Preview를 표시할 수 없습니다. {error}</div>}
    <canvas ref={canvas} aria-label="읽기 전용 Excel PDF preview" />
    {state.highlights.map((h, i) => <div className={`semantic-chip ${h.type.toLowerCase()}`} key={`${h.sheet}-${h.a1Range}-${i}`}>{h.type} · {h.sheet}!{h.a1Range}</div>)}
  </div>;
}
