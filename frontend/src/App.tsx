import { useEffect, useMemo, useReducer, useState } from "react";
import { LibreOfficePdfViewerAdapter } from "./viewer/LibreOfficePdfViewerAdapter";
import { JsonCellViewer } from "./viewer/JsonCellViewer";
import { SheetNavigator, type SheetInfo } from "./viewer/SheetNavigator";
import { SourceInspector, type SourceInfo } from "./viewer/SourceInspector";
import "./app.css";

interface DocItem { document_id: string; filename: string; nodes: number }
interface DkgItem {
  id: string; name: string; member_document_count: number;
  source_location_count: number; value_count: number;
  member_documents: { document_id: string; filename: string; nodes: string[]; first_locator: string; sources: number }[];
}
interface ConceptNode { id: string; name: string; level: string; root: string | null; parent: string | null; synonyms?: string[] }

export default function App() {
  const [, redraw] = useReducer(x => x + 1, 0);
  const adapter = useMemo(() => new LibreOfficePdfViewerAdapter(redraw), []);
  const [sheets, setSheets] = useState<SheetInfo[]>([]);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);
  const [docVersion, setDocVersion] = useState<string | null>(null);
  const [dkgs, setDkgs] = useState<DkgItem[]>([]);
  const [expandedDkg, setExpandedDkg] = useState<string | null>(null);
  const [concepts, setConcepts] = useState<ConceptNode[]>([]);
  const [tab, setTab] = useState<"dkg" | "docs">("dkg");

  useEffect(() => {
    fetch("/api/documents").then(r => r.json()).then(setDocuments).catch(console.error);
  }, []);

  useEffect(() => {
    fetch("/api/kg/document").then(r => r.json()).then(setDkgs).catch(console.error);
  }, []);

  useEffect(() => {
    fetch("/api/kg/domain").then(r => r.json()).then(d => {
      setConcepts(d.nodes || []);
    }).catch(console.error);
  }, []);

  const loadDocument = async (docId: string) => {
    setSelectedDoc(docId);
    try {
      const vr = await fetch(`/api/viewer/documents/${encodeURIComponent(docId)}/versions/first`);
      const vd = await vr.json();
      setDocVersion(vd.document_version);
      adapter.loadDocument(docId, vd.document_version);
      const sr = await fetch(`/api/viewer/documents/${encodeURIComponent(docId)}/sheets?document_version=${encodeURIComponent(vd.document_version)}`);
      const s: SheetInfo[] = await sr.json();
      setSheets(s);
      if (s.length) adapter.openSheet(s[0].sheet_name);
    } catch {
      setDocVersion("auto");
      adapter.loadDocument(docId, "auto");
    }
  };

  const toggleDkg = (id: string) => setExpandedDkg(expandedDkg === id ? null : id);

  const conceptTree = useMemo(() => {
    const byParent = new Map<string, ConceptNode[]>();
    const roots: ConceptNode[] = [];
    for (const c of concepts) {
      if (!c.parent) roots.push(c);
      else { const arr = byParent.get(c.parent) || []; arr.push(c); byParent.set(c.parent, arr); }
    }
    return { roots, byParent };
  }, [concepts]);

  const renderConcept = (c: ConceptNode, depth: number = 0): React.ReactNode => {
    const children = conceptTree.byParent.get(c.id) || [];
    return <div key={c.id}>
      <div style={{paddingLeft: depth * 14, fontSize: 11, padding: "3px 4px", cursor: "default",
        color: c.level === "L1" ? "#087b61" : c.level === "L2" ? "#1565c0" : "#555",
        fontWeight: c.level === "L1" ? 700 : c.level === "L2" ? 600 : 400}}>
        {children.length > 0 && <span style={{marginRight: 4, fontSize: 9}}>▸</span>}
        {c.name}
        {c.synonyms?.length ? <span style={{color: "#999", fontSize: 9, marginLeft: 4}}>({c.synonyms.slice(0,2).join(", ")})</span> : null}
      </div>
      {children.map(ch => renderConcept(ch, depth + 1))}
    </div>;
  };

  return <main>
    <header className="topbar">
      <div className="brand"><i>KG</i><div><strong>MLCC 첨가제</strong><span>Knowledge Graph + Source Viewer</span></div></div>
      <div className="status"><span className="dot"/>DRM 파일 · COM 렌더링 · {documents.length} 문서</div>
    </header>
    <section className="workspace">
      <aside className="navigation">
        <div className="nav-tabs">
          <button className={tab === "dkg" ? "active" : ""} onClick={() => setTab("dkg")}>Document KG</button>
          <button className={tab === "docs" ? "active" : ""} onClick={() => setTab("docs")}>문서</button>
        </div>

        {tab === "dkg" && <>
          <div style={{maxHeight: "40vh", overflowY: "auto", borderBottom: "1px solid #eee"}}>
            {dkgs.map(dkg => (
              <div key={dkg.id}>
                <div className="dkg-header" onClick={() => toggleDkg(dkg.id)}
                  style={{padding: "6px 8px", cursor: "pointer", background: expandedDkg === dkg.id ? "#e8f5e9" : undefined,
                    borderBottom: "1px solid #f0f0f0", display: "flex", justifyContent: "space-between", alignItems: "center"}}>
                  <div>
                    <span style={{fontSize: 10, marginRight: 4}}>{expandedDkg === dkg.id ? "▼" : "▶"}</span>
                    <strong style={{fontSize: 12}}>{dkg.name}</strong>
                  </div>
                  <span style={{fontSize: 10, color: "#888"}}>{dkg.member_document_count}문서 · {dkg.source_location_count}소스</span>
                </div>
                {expandedDkg === dkg.id && dkg.member_documents.map(doc => (
                  <div key={doc.document_id} className="doc-item"
                    style={{paddingLeft: 20, background: selectedDoc === doc.document_id ? "#e3f2fd" : undefined}}
                    onClick={() => loadDocument(doc.document_id)}>
                    <span style={{fontSize: 11}}>{doc.filename}</span>
                    <span style={{fontSize: 9, color: "#888"}}>{doc.sources} sources</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <h3 style={{fontSize: 13, margin: "10px 8px 6px", color: "#333"}}>Domain Concepts</h3>
          <div style={{maxHeight: "40vh", overflowY: "auto"}}>
            {conceptTree.roots.map(c => renderConcept(c))}
          </div>
        </>}

        {tab === "docs" && <div style={{maxHeight: "100%", overflowY: "auto"}}>
          {documents.map(doc => (
            <div key={doc.document_id} className={`doc-item ${selectedDoc === doc.document_id ? "active" : ""}`}
              style={{background: selectedDoc === doc.document_id ? "#e3f2fd" : undefined}}
              onClick={() => loadDocument(doc.document_id)}>
              <span style={{fontSize: 11}}>{doc.filename}</span>
            </div>
          ))}
        </div>}
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
        <SheetNavigator sheets={sheets} current={adapter.state.sheet} onOpen={name => adapter.openSheet(name)}/>
      </section>
      <SourceInspector source={source}/>
    </section>
    <footer><span>Documents</span><b>{documents.length}</b><span style={{marginLeft: 12}}>DKGs</span><b>{dkgs.length}</b><span style={{marginLeft: 12}}>Concepts</span><b>{concepts.length}</b></footer>
  </main>;
}
