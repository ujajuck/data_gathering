// 파싱 스키마 가져오기 대화상자(§6): 정의 JSON 붙여넣기/업로드 → 'new'는 POST /schemas {definition},
// 'revision'은 PUT /schemas/{key} {definition}(새 리비전). 저장 없이 미리보기는 없다(스키마는 canonical 정의만 받는다).
import { useMemo, useState } from "react";
import { api, errorMessage } from "./client";
import type { SchemaDetail } from "./types";
import { Modal } from "./ui";

export type SchemaImportMode = { kind: "new" } | { kind: "revision"; schemaKey: string; schemaName: string };

export function parseSchemaDefinition(text: string): { definition: Record<string, unknown> | null; error: string } {
  if (!text.trim()) return { definition: null, error: "" };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { definition: null, error: "정의는 JSON 객체여야 합니다." };
    return { definition: parsed as Record<string, unknown>, error: "" };
  } catch {
    return { definition: null, error: "JSON을 해석할 수 없습니다." };
  }
}

// 정의 안의 schema_key·schema_name·fields 수를 요약한다(저장 전 확인용).
export function summarizeDefinition(definition: Record<string, unknown> | null): { key: string; name: string; fields: number } | null {
  if (!definition) return null;
  const key = typeof definition.schema_key === "string" ? definition.schema_key : "";
  const name = typeof definition.schema_name === "string" ? definition.schema_name : typeof definition.name === "string" ? definition.name : "";
  const fields = Array.isArray(definition.fields) ? definition.fields.length : 0;
  return { key, name, fields };
}

export default function SchemaImport({ mode, onClose, onSaved }: { mode: SchemaImportMode; onClose: () => void; onSaved: (schema: SchemaDetail) => void }) {
  const title = mode.kind === "new" ? "새 스키마" : `새 리비전 · ${mode.schemaName}`;
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const parsed = useMemo(() => parseSchemaDefinition(text), [text]);
  const summary = summarizeDefinition(parsed.definition);

  function upload(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(file);
  }
  async function save() {
    if (!parsed.definition) return;
    setSaving(true);
    setError("");
    try {
      const result =
        mode.kind === "new"
          ? await api<SchemaDetail>("/schemas", { definition: parsed.definition })
          : await api<SchemaDetail>("/schemas/" + encodeURIComponent(mode.schemaKey), { definition: parsed.definition }, { method: "PUT" });
      onSaved(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      label={title}
      title={title}
      className="narrow"
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="button" className="primary" disabled={!parsed.definition || saving} onClick={save}>
            {mode.kind === "new" ? "가져오기" : "새 리비전 저장"}
          </button>
        </>
      }
    >
      <div className="v3-stack">
        <p className="v3-muted v3-small">
          {mode.kind === "new"
            ? "파싱 스키마 정의 JSON(schema_key · schema_name · fields[])을 붙여넣거나 파일로 올리면 새 스키마가 만들어집니다."
            : "같은 schema_key의 정의를 올리면 새 리비전으로 저장됩니다. 기존 필드 키는 유지하세요."}
        </p>
        <label>
          파일 업로드
          <input type="file" accept=".json,application/json" onChange={(e) => upload(e.target.files?.[0])} />
        </label>
        <label>
          정의 JSON
          <textarea
            className="v3-json-editor"
            rows={12}
            spellCheck={false}
            placeholder='{"schema_key": "process_std", "schema_name": "공정 데이터 표준", "fields": [...]}'
            aria-invalid={text && parsed.error ? true : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {text && parsed.error && (
          <div className="v3-error" role="alert">
            <span>{parsed.error}</span>
          </div>
        )}
        {summary && (
          <p className="v3-small" aria-label="정의 요약">
            {summary.name || <span className="v3-muted">이름 없음</span>}
            {summary.key ? ` (${summary.key})` : ""} · 필드 {summary.fields}
          </p>
        )}
        {error && (
          <div className="v3-error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
