export interface SheetInfo {sheet_index: number; sheet_name: string; state: string}
export function SheetNavigator({sheets, current, onOpen}: {sheets: SheetInfo[]; current: string | null; onOpen: (name: string) => void}) {
  return <nav className="sheets" aria-label="Workbook sheets">{sheets.map(sheet =>
    <button className={current === sheet.sheet_name ? "active" : ""} key={sheet.sheet_index} onClick={() => onOpen(sheet.sheet_name)}>
      {sheet.sheet_name}{sheet.state !== "visible" && <small>{sheet.state}</small>}
    </button>)}</nav>;
}
