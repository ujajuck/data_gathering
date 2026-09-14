// 데이터 빌드 3단계 출력 설정(ui-development-spec §6 "출력 Header 편집"): 사용 ☑ · 원본 Field · 출력 Header 입력 ·
// Type · Unit · 값 있는 문서 · 순서(↑↓ + HTML5 드래그). 빈 값/중복은 즉시 오류이며 다음 단계가 비활성화된다.
import { useRef, useState } from "react";
import type { DragEvent } from "react";
import type { RowMode } from "./types";
import type { ColumnConfig } from "./buildModel";
import { ROW_MODE_LABELS, moveColumn } from "./buildModel";

export default function BuildColumns({
  columns,
  errors,
  usable,
  rowMode,
  onChange,
  onRowMode,
  onBack,
  onNext,
  nextEnabled,
}: {
  columns: ColumnConfig[];
  errors: Record<string, string>;
  usable: number;
  rowMode: RowMode;
  onChange: (next: ColumnConfig[]) => void;
  onRowMode: (mode: RowMode) => void;
  onBack: () => void;
  onNext: () => void;
  nextEnabled: boolean;
}) {
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const enabledCount = columns.filter((c) => c.enabled).length;
  const errorCount = Object.keys(errors).length;

  const patch = (index: number, change: Partial<ColumnConfig>) =>
    onChange(columns.map((c, i) => (i === index ? { ...c, ...change } : c)));
  const move = (from: number, to: number) => {
    const next = moveColumn(columns, from, to);
    if (next !== columns) onChange(next);
  };
  function onDragStart(e: DragEvent<HTMLTableRowElement>, index: number) {
    dragFrom.current = index;
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", columns[index].field_key);
    } catch {
      // jsdom 등 dataTransfer가 없는 환경
    }
  }
  function onDragOver(e: DragEvent<HTMLTableRowElement>, index: number) {
    if (dragFrom.current === null) return;
    e.preventDefault();
    if (dropAt !== index) setDropAt(index);
  }
  function onDrop(e: DragEvent<HTMLTableRowElement>, index: number) {
    e.preventDefault();
    if (dragFrom.current !== null) move(dragFrom.current, index);
    dragFrom.current = null;
    setDropAt(null);
  }
  function onDragEnd() {
    dragFrom.current = null;
    setDropAt(null);
  }

  return (
    <section className="v3-card">
      <div className="v3-card-head">
        <h2>출력 컬럼 설정</h2>
        <span className="v3-small">
          사용 {enabledCount}/{columns.length}개
          {errorCount ? ` · 오류 ${errorCount}건` : ""}
        </span>
      </div>
      <p className="v3-muted">출력 Header는 필드명이 기본값입니다. 빈 값과 중복은 허용되지 않으며, 순서는 ↑↓ 버튼이나 드래그로 바꿉니다.</p>
      <div className="v3-table-wrap">
        <table className="v3-table v3-build-columns" aria-label="출력 컬럼 설정">
          <thead>
            <tr>
              <th scope="col">사용</th>
              <th scope="col">원본 Field</th>
              <th scope="col">출력 Header</th>
              <th scope="col">Type</th>
              <th scope="col">Unit</th>
              <th scope="col">값 있는 문서</th>
              <th scope="col">순서</th>
            </tr>
          </thead>
          <tbody>
            {columns.map((c, i) => {
              const error = errors[c.field_key];
              const errorId = `v3-build-header-error-${c.field_key}`;
              return (
                <tr
                  key={c.field_key}
                  draggable
                  data-field={c.field_key}
                  className={[c.enabled ? "" : "v3-column-off", dropAt === i ? "v3-drop-target" : ""].join(" ").trim() || undefined}
                  onDragStart={(e) => onDragStart(e, i)}
                  onDragOver={(e) => onDragOver(e, i)}
                  onDrop={(e) => onDrop(e, i)}
                  onDragEnd={onDragEnd}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${c.name} 사용`}
                      checked={c.enabled}
                      onChange={(e) => patch(i, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    {c.name}
                    <span className="v3-small v3-muted"> {c.field_key}</span>
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`${c.name} 출력 Header`}
                      value={c.header}
                      disabled={!c.enabled}
                      aria-invalid={error ? "true" : undefined}
                      aria-describedby={error ? errorId : undefined}
                      onChange={(e) => patch(i, { header: e.target.value })}
                    />
                    {error && (
                      <span className="v3-error v3-small v3-inline-error" id={errorId}>
                        {error}
                      </span>
                    )}
                  </td>
                  <td>{c.type || "-"}</td>
                  <td>{c.unit || "-"}</td>
                  <td className="num">
                    {c.document_count}/{usable}
                  </td>
                  <td>
                    <span className="v3-inline">
                      <button type="button" className="small" aria-label={`${c.name} 위로`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                        ↑
                      </button>
                      <button
                        type="button"
                        className="small"
                        aria-label={`${c.name} 아래로`}
                        disabled={i === columns.length - 1}
                        onClick={() => move(i, i + 1)}
                      >
                        ↓
                      </button>
                      <span className="v3-drag-handle" aria-hidden="true" title="드래그하여 순서 변경">
                        ↕
                      </span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {enabledCount === 0 && <p className="v3-note">출력할 컬럼을 하나 이상 선택하세요.</p>}
      <div className="v3-form">
        <label>
          행 구성
          <select value={rowMode} onChange={(e) => onRowMode(e.target.value as RowMode)}>
            {(Object.keys(ROW_MODE_LABELS) as RowMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {ROW_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
        <p className="v3-small v3-muted">
          레코드마다 1행: 문서 안의 레코드마다 한 행(단일 값은 모든 행에 복제). 문서마다 1행: 문서당 한 행(목록은 첫 값 + 개수).
        </p>
      </div>
      <div className="v3-toolbar v3-toolbar-end">
        <button type="button" onClick={onBack}>
          이전
        </button>
        <button type="button" className="primary" disabled={!nextEnabled} onClick={onNext}>
          다음: 미리보기
        </button>
      </div>
    </section>
  );
}
