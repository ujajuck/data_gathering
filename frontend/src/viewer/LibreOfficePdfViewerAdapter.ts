import type { CellRange, HighlightedRange, SemanticType, WorkbookViewerAdapter } from "./ViewerAdapter";

export interface PdfViewerState {
  documentId: string | null; version: string | null; sheet: string | null;
  selectedRange: CellRange | null; highlights: HighlightedRange[]; zoom: number;
}

/** State adapter for the LibreOffice/PDF.js engine; it contains no KG logic. */
export class LibreOfficePdfViewerAdapter implements WorkbookViewerAdapter {
  readonly state: PdfViewerState = { documentId: null, version: null, sheet: null, selectedRange: null, highlights: [], zoom: 1 };
  constructor(private readonly changed: () => void) {}
  async loadDocument(documentId: string, version: string) { this.state.documentId = documentId; this.state.version = version; this.state.sheet = null; this.state.selectedRange = null; this.state.highlights = []; this.changed(); }
  async openSheet(sheetName: string) { this.state.sheet = sheetName; this.changed(); }
  async focusRange(range: CellRange) { this.state.sheet = range.sheet; this.state.selectedRange = range; this.changed(); }
  highlightRange(range: CellRange, type: SemanticType) { this.state.highlights = [...this.state.highlights, {...range, type}]; this.changed(); }
  clearHighlight() { this.state.highlights = []; this.changed(); }
  getSelectedRange() { return this.state.selectedRange; }
  getVisibleSheet() { return this.state.sheet; }
  zoomIn() { this.state.zoom = Math.min(3, this.state.zoom + .15); this.changed(); }
  zoomOut() { this.state.zoom = Math.max(.4, this.state.zoom - .15); this.changed(); }
  fitToWidth() { this.state.zoom = 1; this.changed(); }
}
