import { useEffect, useMemo, useReducer, useState } from "react";
import { LibreOfficePdfViewerAdapter } from "./viewer/LibreOfficePdfViewerAdapter";
import { JsonCellViewer } from "./viewer/JsonCellViewer";
import { SheetNavigator, type SheetInfo } from "./viewer/SheetNavigator";
import { SourceInspector, type SourceInfo } from "./viewer/SourceInspector";
import { ParsingTemplatePanel, type TemplateGroup } from "./parsing/ParsingTemplatePanel";
import "./app.css";

interface DocItem { document_id: string; filename: string; nodes: number }

export default function App() {
  const [, redraw] = useReducer(x => x + 1, 0);
  const adapter = useMemo(() => new LibreOfficePdfViewerAdapter(redraw), []);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [groups, setGroups] = useState<TemplateGroup[]>([]);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docVersion, setDocVersion] = useState<string | null>(null);

  // 문서 목록 로드
  useEffect(() => {
    fetch("/api/documents").then(r => r.json()).then(setDocuments).catch(console.error);
  }, []);

  // KG navigation (query param)
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    const documentId = query.get("documentId"), version = query.get("version");
    const sheet = query.get("sheet"), range = query.get("range");
    const documentKg = query.get("documentKg");
    if (documentKg) fetch(`/api/parsing/document-kg/${encodeURIComponent(documentKg)}/groups`)
      .then(r => r.json()).then(setGroups).catch(console.error);
    if (documentId && version && sheet && range) {
      setSelectedDoc(documentId);
      setDocVersion(version);
      adapter.loadDocument(documentId, version);
      adapter.openSheet(sheet);
      adapter.focusRange({sheet, a1Range: range});
      adapter.highlightRange({sheet, a1Range: range}, "MAPPING_SOURCE");
    }
  }, [adapter]);

  // 문서 선택 시 시트 목록 로드
  useEffect(() => {
    if (!selectedDoc) return;
    // document_version 찾기
    fetch(`/api/viewer/documents/${encodeURIComponent(selectedDoc)}/versions/first`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then(d => { setDocVersion(d.document_version); return d.document_version; })
      .then(ver => fetch(`/api/viewer/documents/${encodeURIComponent(selectedDoc)}/sheets?document_version=${encodeURIComponent(ver)}`))
      .then(r => r.json())
      .then((s: SheetInfo[]) => { setSheets(s); if (s.length) adapter.openSheet(s[0].sheet_name); })
      .catch(() => {
        // 폴백: document_version 테이블에서 직접 조회
        fetch(`/api/documents`).then(r => r.json()).then((docs: DocItem[]) => {
          const doc = docs.find(d => d.document_id === selectedDoc);
          if (!doc) return;
          // 임시 버전 — 첫 버전 사용
          setDocVersion("auto");
          fetch(`/api/viewer/documents/${encodeURIComponent(selectedDoc)}/sheets?document_version=auto`)
            .then(r => r.json()).then((s: SheetInfo[]) => { setSheets(s); if (s.length) adapter.openSheet(s[0].sheet_name); })
            .catch(console.error);
        });
      });
  }, [selectedDoc]);

  const handleDocClick = (docId: string) => {
    setSelectedDoc(docId);
    adapter.loadDocument(docId, docVersion || "auto");
  };

  const handleSheetClick = (name: string) => {
    adapter.openSheet(name);
  };

  return <main>
    <header className="topbar">
      <div className="brand"><i>KG</i><div><strong>Source Viewer</strong><span>MLCC 첨가제 데이터</span></div></div>
      <div className="status"><span className="dot"/>DRM 파일 · COM 렌더링</div>
    </header>
    <section className="workspace">
      <aside className="navigation">
        <h2>문서 목록</h2>
        <div className="doc-list" style={{maxHeight: "60vh", overflowY: "auto"}}>
          {documents.map(doc => (
            <div key={doc.document_id}
              className={`doc-item ${selectedDoc === doc.document_id ? "active" : ""}`}
              style={{padding: "6px 8px", cursor: "pointer", borderBottom: "1px solid #eee",
                background: selectedDoc === doc.document_id ? "#e3f2fd" : undefined}}
              onClick={() => handleDocClick(doc.document_id)}>
              <span style={{fontSize: 12}}>{doc.filename}</span>
            </div>
          ))}
        </div>
        <h2 style={{marginTop: 16}}>Knowledge Graph</h2>
        <ParsingTemplatePanel groups={groups}/>
      </aside>
      <section className="viewer">
        <div className="viewer-toolbar">
          <div>
            <strong>{documents.find(d => d.document_id === selectedDoc)?.filename || "Workbook Viewer"}</strong>
            <span>{adapter.state.sheet || "시트를 선택하세요"}</span>
          </div>
          <div className="tools">
            <label><input type="checkbox" checked={overlayVisible} onChange={e => setOverlayVisible(e.target.checked)}/> Semantic</label>
            <button onClick={() => adapter.zoomOut()}>−</button>
            <button onClick={() => adapter.fitToWidth()}>맞춤</button>
            <button onClick={() => adapter.zoomIn()}>＋</button>
          </div>
        </div>
        <JsonCellViewer
          documentId={adapter.state.documentId}
          version={adapter.state.version}
          sheet={adapter.state.sheet}
          highlights={overlayVisible ? adapter.state.highlights : []}
          zoom={adapter.state.zoom}
        />
        <SheetNavigator sheets={sheets} current={adapter.state.sheet} onOpen={handleSheetClick}/>
      </section>
      <SourceInspector source={source}/>
    </section>
    <footer><span>Documents</span><b>{documents.length}</b></footer>
  </main>;
}
