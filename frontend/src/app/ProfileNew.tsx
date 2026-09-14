// 새 프로파일 대화상자(§7 Profiles). 버튼은 목록의 `+ 새 프로파일` 하나뿐이고, 시작 방법을 라디오로 고른다:
// 빈 골격으로 시작(기본) · 정의 붙여넣기 또는 파일 업로드. 붙여넣은 JSON은 POST /profiles/import-preview
// {schema_key, definition, format:'auto'}로 형식을 자동 판별해 canonical 미리보기와 경고·오류를 보여 준다.
// 저장은 POST /profiles. 저장 전에는 리비전이 없어 테스트할 수 없다 — 테스트는 저장 뒤 상세 화면에서 한다.
import { useEffect, useMemo, useState } from "react";
import { State, api, errorMessage, useData, useDebounced } from "./client";
import type { Page, ProfileImportPreview, ProfileSaveResult, SchemaRow } from "./types";
import { Chip, Modal } from "./ui";
import { newProfileSkeleton, parseDefinition, pretty, problemText } from "./profileModel";
import type { Problem } from "./profileModel";

export default function ProfileNew({ onClose, onSaved }: { onClose: () => void; onSaved: (profile: ProfileSaveResult) => void }) {
  const title = "새 프로파일";
  const schemas = useData<Page<SchemaRow>>("/schemas");
  const schemaList = schemas.data?.items ?? [];
  const [schemaKey, setSchemaKey] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState<"skeleton" | "paste">("skeleton");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (!schemaKey && schemaList.length) setSchemaKey(schemaList[0].schema_key);
  }, [schemaKey, schemaList]);
  // 빈 골격으로 시작: 고른 스키마의 canonical 3.0 골격을 채워 둔다. 붙여넣기로 바꾸면 비운다.
  useEffect(() => {
    if (start === "skeleton" && schemaKey) setText(pretty(newProfileSkeleton(schemaKey)));
  }, [start, schemaKey]);
  const parsed = useMemo(() => parseDefinition(text), [text]);
  const debouncedText = useDebounced(text, 400);
  // 형식 자동 판별: 붙여넣은 JSON이 파싱되면 400ms 뒤 미리보기를 요청한다.
  useEffect(() => {
    const { definition } = parseDefinition(debouncedText);
    if (!schemaKey || !definition) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setPreviewError("");
    api<ProfileImportPreview>("/profiles/import-preview", { schema_key: schemaKey, definition, format: "auto" })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((failure) => {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedText, schemaKey]);
  const errors: Problem[] = (preview?.errors as Problem[] | undefined) || [];
  const warnings: Problem[] = (preview?.warnings as Problem[] | undefined) || [];
  const canonicalName = preview?.canonical && typeof preview.canonical.profile_name === "string" ? preview.canonical.profile_name : "";

  function upload(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setStart("paste");
      setText(String(reader.result || ""));
    };
    reader.readAsText(file);
    if (!name && file.name) setName(file.name.replace(/\.json$/i, ""));
  }
  async function save() {
    if (!parsed.definition || !schemaKey) return;
    setSaving(true);
    setSaveError("");
    try {
      const body: Record<string, unknown> = { schema_key: schemaKey, definition: parsed.definition, format: "auto" };
      if (name.trim()) body.name = name.trim();
      onSaved(await api<ProfileSaveResult>("/profiles", body));
    } catch (failure) {
      setSaveError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      label={title}
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button type="button" className="primary" disabled={!parsed.definition || !schemaKey || saving || errors.length > 0} onClick={save}>
            저장
          </button>
        </>
      }
    >
      <div className="app-stack">
        <p className="app-muted app-small">
          시작 방법을 고르세요. 붙여넣거나 올린 정의는 형식을 자동으로 판별해 canonical 3.0으로 바꿔 보여 줍니다.
        </p>
        <p className="app-muted app-small">저장한 뒤 상세 화면에서 문서를 골라 테스트하세요.</p>
        <div className="app-form-grid">
          <label>
            파싱 스키마
            <select value={schemaKey} onChange={(e) => setSchemaKey(e.target.value)} disabled={schemas.loading}>
              {schemaList.length === 0 && <option value="">{schemas.loading ? "불러오는 중…" : "스키마 없음"}</option>}
              {schemaList.map((s) => (
                <option key={s.schema_key} value={s.schema_key}>
                  {s.schema_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            프로파일명
            <input value={name} placeholder={canonicalName || "비우면 정의의 profile_name"} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            파일 업로드
            <input type="file" accept=".json,application/json" onChange={(e) => upload(e.target.files?.[0])} />
          </label>
        </div>
        <State resource={schemas} isEmpty={false} />
        <div className="app-list" role="radiogroup" aria-label="시작 방법">
          <label className="app-check app-list-item">
            <input
              type="radio"
              name="profile-start"
              aria-label="빈 골격으로 시작"
              checked={start === "skeleton"}
              onChange={() => {
                setStart("skeleton");
                if (schemaKey) setText(pretty(newProfileSkeleton(schemaKey)));
              }}
            />
            <span>
              <strong>빈 골격으로 시작</strong>
              <small>canonical 3.0 기본 골격을 채워 둡니다.</small>
            </span>
          </label>
          <label className="app-check app-list-item">
            <input
              type="radio"
              name="profile-start"
              aria-label="정의 붙여넣기 또는 파일 업로드"
              checked={start === "paste"}
              onChange={() => {
                setStart("paste");
                setText("");
              }}
            />
            <span>
              <strong>정의 붙여넣기 또는 파일 업로드</strong>
              <small>예전 양식 정의나 key-value JSON도 형식을 판별합니다.</small>
            </span>
          </label>
        </div>
        <label>
          정의 JSON
          <textarea
            className="app-json-editor"
            rows={12}
            spellCheck={false}
            placeholder='{"format": "parsing-profile", ...} 또는 예전 양식 정의를 붙여넣기'
            aria-invalid={text && parsed.error ? true : undefined}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {text && parsed.error && (
          <div className="app-error" role="alert">
            <span>{parsed.error}</span>
          </div>
        )}
        {previewError && (
          <div className="app-error" role="alert">
            <span>{previewError}</span>
          </div>
        )}
        {checking && (
          <p className="app-muted app-small" role="status">
            형식을 판별하는 중…
          </p>
        )}
        {preview && (
          <section className="app-stack app-problems" aria-label="변환 미리보기">
            <p className="app-small">
              판별된 형식 <Chip kind="blue">{preview.format_detected}</Chip>{" "}
              {errors.length === 0 ? <Chip kind="ok">오류 없음</Chip> : <Chip kind="err">오류 {errors.length}</Chip>}
              {warnings.length > 0 && <Chip kind="warn">경고 {warnings.length}</Chip>}
            </p>
            {errors.length > 0 && (
              <div className="app-error" role="alert">
                <ul aria-label="오류">
                  {errors.map((p, i) => (
                    <li key={i}>{problemText(p)}</li>
                  ))}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <ul className="app-note" aria-label="경고">
                {warnings.map((p, i) => (
                  <li key={i}>{problemText(p)}</li>
                ))}
              </ul>
            )}
            <label>
              canonical 미리보기
              <textarea className="app-json-editor" rows={10} readOnly spellCheck={false} value={pretty(preview.canonical)} />
            </label>
          </section>
        )}
        {saveError && (
          <div className="app-error" role="alert">
            <span>{saveError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
