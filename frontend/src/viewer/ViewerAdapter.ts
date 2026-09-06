export type SemanticType = "KEY" | "VALUE" | "CONTEXT" | "HEADER" | "UNIT" | "TABLE" | "IMAGE" | "MAPPING_SOURCE";

export interface CellRange {
  sheet: string;
  a1Range: string;
  startRow?: number;
  startCol?: number;
  endRow?: number;
  endCol?: number;
}

export interface HighlightedRange extends CellRange { type: SemanticType }

/** Engine-neutral contract. KG and mapping components only use this interface. */
export interface WorkbookViewerAdapter {
  loadDocument(documentId: string, version: string): Promise<void>;
  openSheet(sheetName: string): Promise<void>;
  focusRange(range: CellRange): Promise<void>;
  highlightRange(range: CellRange, type: SemanticType): void;
  clearHighlight(): void;
  getSelectedRange(): CellRange | null;
  getVisibleSheet(): string | null;
  zoomIn(): void;
  zoomOut(): void;
  fitToWidth(): void;
}
