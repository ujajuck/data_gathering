// 파싱 스키마 쓰기 대화상자(§6·§7). 세 가지 모드를 한 파일에서 쓴다.
// - `new`: 정의 JSON 붙여넣기/업로드 → POST /schemas(생성 전용 — 이미 있는 키면 409 SCHEMA_EXISTS 메시지를 그대로 보여 준다)
// - `revision`: 현재 정의(GET /schemas/{key}/revisions/{rev})를 채워 두고 고쳐서 PUT /schemas/{key}(새 리비전)
// - `rename`: 현재 정의의 schema_name만 바꿔 PUT(작은 대화상자)
// 필드 추가 대화상자(FieldCreateDialog)도 여기 있다: POST /schemas/{key}/fields → 응답은 필드 상세.
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { State, api, errorMessage, useData } from "./client";
import type { FieldDetail, SchemaSaveResult } from "./types";
import { Modal } from "./ui";

export type SchemaEditorMode =
  | { kind: "new" }
  | { kind: "revision"; schemaKey: string; schemaName: string; currentRev: number }
  | { kind: "rename"; schemaKey: string; schemaName: string; currentRev: number };

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

const revisionPath = (key: string, rev: number) => `/schemas/${encodeURIComponent(key)}/revisions/${rev}`;

export default function SchemaEditor({ mode, onClose, onSaved }: { mode: SchemaEditorMode; onClose: () => void; onSaved: (schema: SchemaSaveResult) => void }) {
  if (mode.kind === "rename") return <RenameDialog mode={mode} onClose={onClose} onSaved={onSaved} />;
  return <DefinitionDialog mode={mode} onClose={onClose} onSaved={onSaved} />;
}

function DefinitionDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "new" } | { kind: "revision"; schemaKey: string; schemaName: string; currentRev: number };
  onClose: () => void;
  onSaved: (schema: SchemaSaveResult) => void;
}) {
  const title = mode.kind === "new" ? "새 스키마" : `새 리비전 · ${mode.schemaName}`;
  // 새 리비전은 현재 정의를 채워 두고 고치게 한다(빈 편집기에 다시 쓰게 하지 않는다).
  const current = useData<Record<string, unknown>>(mode.kind === "revision" ? revisionPath(mode.schemaKey, mode.currentRev) : null);
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!touched && current.data) setText(JSON.stringify(current.data, null, 2));
  }, [current.data, touched]);
  const parsed = useMemo(() => parseSchemaDefinition(text), [text]);
  const summary = summarizeDefinition(parsed.definition);

  function upload(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setTouched(true);
      setText(String(reader.result || ""));
    };
    reader.readAsText(file);
  }
  async function save() {
    if (!parsed.definition) return;
    setSaving(true);
    setError("");
    try {
      const result =
        mode.kind === "new"
          ? await api<SchemaSaveResult>("/schemas", { definition: parsed.definition })
          : await api<SchemaSaveResult>("/schemas/" + encodeURIComponent(mode.schemaKey), { definition: parsed.definition }, { method: "PUT" });
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
      <div className="app-stack">
        <p className="app-muted app-small">
          {mode.kind === "new"
            ? "파싱 스키마 정의 JSON(schema_key · schema_name · fields[])을 붙여넣거나 파일로 올리면 새 스키마가 만들어집니다. 이미 있는 스키마 키는 만들 수 없습니다 — 그 스키마를 열어 '새 리비전'을 쓰세요."
            : "현재 정의를 채워 두었습니다. 고쳐서 저장하면 새 리비전이 됩니다. 기존 필드 키는 유지하세요."}
        </p>
        <State resource={current} isEmpty={false} />
        <label>
          파일 업로드
          <input type="file" accept=".json,application/json" onChange={(e) => upload(e.target.files?.[0])} />
        </label>
        <label>
          정의 JSON
          <textarea
            className="app-json-editor"
            rows={12}
            spellCheck={false}
            placeholder='{"schema_key": "process_std", "schema_name": "공정 데이터 표준", "fields": [...]}'
            aria-invalid={text && parsed.error ? true : undefined}
            value={text}
            onChange={(e) => {
              setTouched(true);
              setText(e.target.value);
            }}
          />
        </label>
        {text && parsed.error && (
          <div className="app-error" role="alert">
            <span>{parsed.error}</span>
          </div>
        )}
        {summary && (
          <p className="app-small" aria-label="정의 요약">
            {summary.name || <span className="app-muted">이름 없음</span>}
            {summary.key ? ` (${summary.key})` : ""} · 필드 {summary.fields}
          </p>
        )}
        {error && (
          <div className="app-error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// 이름만 바꾼다: 현재 정의를 읽어 schema_name만 갈아 끼우고 PUT(새 리비전).
function RenameDialog({
  mode,
  onClose,
  onSaved,
}: {
  mode: { kind: "rename"; schemaKey: string; schemaName: string; currentRev: number };
  onClose: () => void;
  onSaved: (schema: SchemaSaveResult) => void;
}) {
  const current = useData<Record<string, unknown>>(revisionPath(mode.schemaKey, mode.currentRev));
  const [name, setName] = useState(mode.schemaName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const invalid = !name.trim() || name.trim() === mode.schemaName;
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || !current.data) return;
    setSaving(true);
    setError("");
    try {
      onSaved(
        await api<SchemaSaveResult>(
          "/schemas/" + encodeURIComponent(mode.schemaKey),
          { definition: { ...current.data, schema_name: name.trim() } },
          { method: "PUT" },
        ),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      label="스키마 이름 바꾸기"
      title="스키마 이름 바꾸기"
      className="narrow"
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" form="schema-rename" className="primary" disabled={invalid || saving || !current.data}>
            저장
          </button>
        </>
      }
    >
      <form className="app-form" id="schema-rename" aria-label="스키마 이름 바꾸기" onSubmit={submit}>
        <p className="app-muted app-small">이름만 바꾼 새 리비전을 저장합니다. 필드는 그대로입니다.</p>
        <State resource={current} isEmpty={false} />
        <label>
          스키마명
          <input value={name} aria-invalid={!name.trim() || undefined} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && (
          <div className="app-error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}

// 필드 타입 어휘는 계약 §6 FieldCreateRequest와 같아야 한다 — 다르면 서버가 422로 되돌린다.
const FIELD_TYPES = ["text", "decimal", "boolean", "date", "datetime", "group"];

// 필드 추가 = 새 리비전(§4.2). 응답은 필드 상세라 호출자가 그 필드를 바로 선택할 수 있다.
export function FieldCreateDialog({
  schemaKey,
  nodes,
  parentKey,
  onClose,
  onCreated,
}: {
  schemaKey: string;
  // 상위 필드 선택 목록(트리 평면화 결과).
  nodes: { field_key: string; name: string; level: number }[];
  parentKey?: string;
  onClose: () => void;
  onCreated: (field: FieldDetail) => void;
}) {
  const [form, setForm] = useState({ field_key: "", name: "", type: "text", unit: "", parent_field_key: parentKey || "", description: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const invalid = !form.field_key.trim() || !form.name.trim();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid) return;
    setSaving(true);
    setError("");
    const body: Record<string, unknown> = { field_key: form.field_key.trim(), name: form.name.trim(), type: form.type };
    if (form.unit.trim()) body.unit = form.unit.trim();
    if (form.description.trim()) body.description = form.description.trim();
    if (form.parent_field_key) body.parent_field_key = form.parent_field_key;
    try {
      onCreated(await api<FieldDetail>(`/schemas/${encodeURIComponent(schemaKey)}/fields`, body));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      label="필드 추가"
      title="필드 추가"
      className="narrow"
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" form="schema-field-new" className="primary" disabled={invalid || saving}>
            추가
          </button>
        </>
      }
    >
      <form className="app-form" id="schema-field-new" aria-label="필드 추가" onSubmit={submit}>
        <p className="app-muted app-small">필드를 추가하면 그 필드를 넣은 새 리비전이 저장됩니다.</p>
        <label>
          영문 키
          <input value={form.field_key} placeholder="예: lot_no" aria-invalid={!form.field_key.trim() || undefined} onChange={(e) => setForm({ ...form, field_key: e.target.value })} />
        </label>
        <label>
          필드명
          <input value={form.name} aria-invalid={!form.name.trim() || undefined} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          타입
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          단위
          <input value={form.unit} placeholder="비워 두면 없음" onChange={(e) => setForm({ ...form, unit: e.target.value })} />
        </label>
        <label>
          상위 필드
          <select value={form.parent_field_key} onChange={(e) => setForm({ ...form, parent_field_key: e.target.value })}>
            <option value="">최상위</option>
            {nodes.map((n) => (
              <option key={n.field_key} value={n.field_key}>
                {" ".repeat(Math.max(0, ((n.level ?? 1) - 1) * 2)) + n.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          설명
          <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        {error && (
          <div className="app-error" role="alert">
            <span>{error}</span>
          </div>
        )}
      </form>
    </Modal>
  );
}
