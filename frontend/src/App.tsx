import { useEffect, useMemo, useReducer, useState } from "react";
import { LibreOfficePdfViewerAdapter } from "./viewer/LibreOfficePdfViewerAdapter";
import { PdfWorkbookViewer } from "./viewer/PdfWorkbookViewer";
import { SheetNavigator, type SheetInfo } from "./viewer/SheetNavigator";
import { SourceInspector, type SourceInfo } from "./viewer/SourceInspector";
import { ParsingTemplatePanel, type TemplateGroup } from "./parsing/ParsingTemplatePanel";
import "./app.css";

export default function App() {
  const [, redraw] = useReducer(x => x + 1, 0);
  const adapter = useMemo(() => new LibreOfficePdfViewerAdapter(redraw), []);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [overlayVisible, setOverlayVisible] = useState(true);
  useEffect(() => {
    // KG navigation opens this route with logical identifiers, never a file path.
    const query = new URLSearchParams(location.search);
    const documentId = query.get("documentId"), version = query.get("version");
    const sheet = query.get("sheet"), range = query.get("range");
    const documentKg = query.get("documentKg");
    if (documentKg) fetch(`/api/parsing/document-kg/${encodeURIComponent(documentKg)}/groups`)
      .then(response => response.json()).then(setGroups).catch(console.error);
    if (!documentId || !version || !sheet || !range) return;
    const sourceUrl = `/api/viewer/documents/${encodeURIComponent(documentId)}/source?document_version=${encodeURIComponent(version)}&sheet=${encodeURIComponent(sheet)}&a1_range=${encodeURIComponent(range)}${query.get("concept") ? `&concept_id=${encodeURIComponent(query.get("concept")!)}` : ""}`;
    Promise.all([
      fetch(sourceUrl).then(response => { if (!response.ok) throw new Error("Source를 불러올 수 없습니다"); return response.json(); }),
      fetch(`/api/viewer/documents/${encodeURIComponent(documentId)}/sheets?document_version=${encodeURIComponent(version)}`).then(response => response.json()),
    ]).then(async ([selected, sheetList]) => {
      setSource(selected); setSheets(sheetList); await adapter.loadDocument(documentId, version);
      await adapter.focusRange({sheet, a1Range: selected.a1_range});
      adapter.highlightRange({sheet, a1Range: selected.a1_range}, "MAPPING_SOURCE");
    }).catch(console.error);
  }, [adapter]);
  return <main><header className="topbar"><div className="brand"><i>KG</i><div><strong>Source Viewer</strong><span>Excel evidence workspace</span></div></div><div className="status"><span className="dot"/>Immutable source · Read only</div></header>
    <section className="workspace"><aside className="navigation"><h2>Knowledge Graph</h2><div className="crumb">Domain KG <b>›</b> Document KG <b>›</b> Template</div><ParsingTemplatePanel groups={groups}/></aside>
      <section className="viewer"><div className="viewer-toolbar"><div><strong>{adapter.state.documentId || "Workbook Viewer"}</strong><span>{adapter.state.sheet || "LibreOffice rendering · PDF.js"}</span></div><div className="tools"><label><input type="checkbox" checked={overlayVisible} onChange={event => setOverlayVisible(event.target.checked)}/> Semantic</label><button onClick={() => adapter.zoomOut()}>−</button><button onClick={() => adapter.fitToWidth()}>맞춤</button><button onClick={() => adapter.zoomIn()}>＋</button></div></div>
        <PdfWorkbookViewer state={{...adapter.state, highlights: overlayVisible ? adapter.state.highlights : []}}/><SheetNavigator sheets={sheets} current={adapter.state.sheet} onOpen={name => void adapter.openSheet(name)}/></section>
      <SourceInspector source={source}/></section><footer><span>Selected Sources</span><b>0</b><button disabled>통합 데이터에 추가</button></footer></main>;
}
