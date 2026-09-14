// 외부 Profile Import / 새 프로파일 대화상자(§7 Profiles): 붙여넣기·업로드 → 형식 자동 판별(POST /profiles/import-preview
// {schema_key, definition, format:'auto'}) → canonical 미리보기 + 경고·오류 → '대표 문서로 테스트'(?test=draft) → 저장(POST /profiles).
import { useEffect, useMemo, useRef, useState } from "react";
import { State, api, errorMessage, useData, useDebounced, useNavigation, usePage } from "./client";
import type { DocumentRow, Page, ProfileImportPreview, ProfileSaveResult, SchemaRow } from "./types";
import { Chip, Modal } from "./ui";
import { newProfileSkeleton, parseDefinition, pretty, problemText } from "./profileModel";
import type { Problem } from "./profileModel";
import { setProfileDraft } from "./profileDraft";

export type ImportMode = "import" | "new";

export default function ProfileImport({
  mode,
  onClose,
  onSaved,
}: {
  mode: ImportMode;
  onClose: () => void;
  onSaved: (profile: ProfileSaveResult) => void;
}) {
  const { go } = useNavigation();
  const title = mode === "new" ? "새 프로파일" : "외부 Profile Import";
  const schemas = useData<Page<SchemaRow>>("/schemas");
  const schemaList = schemas.data?.items ?? [];
  const [schemaKey, setSchemaKey] = useState("");
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [testSnapshot, setTestSnapshot] = useState("");
  const seeded = useRef(false);
  useEffect(() => {
    if (!schemaKey && schemaList.length) setSchemaKey(schemaList[0].schema_key);
  }, [schemaKey, schemaList]);
  useEffect(() => {
    if (mode === "new" && schemaKey && !seeded.current) {
      seeded.current = true;
      setText(pretty(newProfileSkeleton(schemaKey)));
    }
  }, [mode, schemaKey]);
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
  const valid = !!preview && errors.length === 0 && !!parsed.definition;
  const documents = usePage<DocumentRow>(valid ? "/documents" : null);
  const candidates = documents.items.filter((d) => d.current_snapshot);
  const snapshotId = testSnapshot || candidates[0]?.current_snapshot?.snapshot_id || "";
  const canonicalName = preview?.canonical && typeof preview.canonical.profile_name === "string" ? preview.canonical.profile_name : "";

  function upload(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(file);
    if (!name && file.name) setName(file.name.replace(/\.json$/i, ""));
  }
  function testDraft() {
    if (!preview || !snapshotId) return;
    setProfileDraft({ schema_key: schemaKey, definition: preview.canonical, profile_name: name || canonicalName || undefined, format: preview.format_detected });
    onClose();
    go({ test: "draft", snapshot: snapshotId, review: "", rule: "", range: "", sheet: "" });
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
          <button
            type="button"
            disabled={!valid || !snapshotId || saving}
            title={!valid ? "오류 없는 미리보기가 있어야 테스트할 수 있습니다." : !snapshotId ? "테스트할 문서가 없습니다." : "저장하지 않고 선택한 문서에 적용해 봅니다."}
            onClick={testDraft}
          >
            대표 문서로 테스트
          </button>
          <button type="button" className="primary" disabled={!parsed.definition || !schemaKey || saving || errors.length > 0} onClick={save}>
            저장
          </button>
        </>
      }
    >
      <div className="v3-stack">
        <p className="v3-muted v3-small">
          {mode === "new"
            ? "canonical 3.0 형식의 기본 골격을 채워 두었습니다. 규칙을 고친 뒤 저장하면 초안 프로파일이 만들어집니다."
            : "v1/v2 정의나 key-value JSON을 붙여넣으면 형식을 판별해 canonical 3.0으로 변환한 결과를 미리 보여줍니다."}
        </p>
        <div className="v3-form-grid">
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
        <label>
          정의 JSON
          <textarea
            className="v3-json-editor"
            rows={12}
            spellCheck={false}
            placeholder='{"format": "parsing-profile", ...} 또는 v1/v2 정의를 붙여넣기'
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
        {previewError && (
          <div className="v3-error" role="alert">
            <span>{previewError}</span>
          </div>
        )}
        {checking && (
          <p className="v3-muted v3-small" role="status">
            형식을 판별하는 중…
          </p>
        )}
        {preview && (
          <section className="v3-stack v3-problems" aria-label="변환 미리보기">
            <p className="v3-small">
              판별된 형식 <Chip kind="blue">{preview.format_detected}</Chip>{" "}
              {errors.length === 0 ? <Chip kind="ok">오류 없음</Chip> : <Chip kind="err">오류 {errors.length}</Chip>}
              {warnings.length > 0 && <Chip kind="warn">경고 {warnings.length}</Chip>}
            </p>
            {errors.length > 0 && (
              <div className="v3-error" role="alert">
                <ul aria-label="오류">
                  {errors.map((p, i) => (
                    <li key={i}>{problemText(p)}</li>
                  ))}
                </ul>
              </div>
            )}
            {warnings.length > 0 && (
              <ul className="v3-note" aria-label="경고">
                {warnings.map((p, i) => (
                  <li key={i}>{problemText(p)}</li>
                ))}
              </ul>
            )}
            <label>
              canonical 미리보기
              <textarea className="v3-json-editor" rows={10} readOnly spellCheck={false} value={pretty(preview.canonical)} />
            </label>
            {valid && (
              <label>
                테스트 문서
                <select value={snapshotId} onChange={(e) => setTestSnapshot(e.target.value)} disabled={candidates.length === 0}>
                  {candidates.length === 0 && <option value="">{documents.loading ? "불러오는 중…" : "문서 없음"}</option>}
                  {candidates.map((d) => (
                    <option key={d.document_id} value={d.current_snapshot!.snapshot_id}>
                      {d.document_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </section>
        )}
        {saveError && (
          <div className="v3-error" role="alert">
            <span>{saveError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
