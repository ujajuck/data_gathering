// 데이터 빌드 화면(§7 Build, ui-development-spec §6): 5단계 스텝퍼 대상 문서 → 스키마 → 출력 설정 → 미리보기 → 생성.
// 1단계는 초안(buildDraft)으로 POST /builds/candidates 1회, 2단계에서 스키마를 고르면 schema_key를 붙여 한 번 더(필드별 값 있는 문서 수).
// 출력 설정(헤더·순서·행 구성)은 buildModel.ts가 sessionStorage에 보관한다. 현재 단계는 URL `step=`.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage, profileLabel, schemaLabel, useData, useNavigation } from "./client";
import type { BuildCandidates, BuildColumn, Page, RowMode, SchemaRow } from "./types";
import { BUILD_REASON_LABELS } from "./types";
import { Chip, EmptyState, Heading } from "./ui";
import { clearBuildDraft, removeFromBuildDraft, setBuildDraftSchema, useBuildDraft } from "./buildDraft";
import type { ColumnConfig } from "./buildModel";
import {
  clearOutputConfig,
  headerErrors,
  mergeColumns,
  readOutputConfig,
  toBuildColumns,
  toOutputConfig,
  writeOutputConfig,
} from "./buildModel";
import BuildColumns from "./BuildColumns";
import BuildOutput from "./BuildOutput";

export const BUILD_STEPS = ["대상 문서", "스키마", "출력 설정", "미리보기", "생성"];

type Loaded<T> = { key: string; data: T | null; error: string; loading: boolean };

export type BuildInput = {
  document_ids: string[];
  schema_key: string;
  columns: BuildColumn[];
  row_mode: RowMode;
};

export default function Build() {
  const { route, go } = useNavigation();
  const draft = useBuildDraft();
  const ids = draft.document_ids.join(",");
  const schemaKey = draft.schema_key || "";
  const candidatesKey = ids ? ids + "|" + schemaKey : "";

  // 후보 문서(+스키마가 정해지면 필드 목록). (문서, 스키마) 조합마다 1회.
  const [candidates, setCandidates] = useState<Loaded<BuildCandidates>>({ key: "", data: null, error: "", loading: false });
  useEffect(() => {
    if (!candidatesKey) {
      setCandidates({ key: "", data: null, error: "", loading: false });
      return;
    }
    let cancelled = false;
    setCandidates((prev) => ({ key: candidatesKey, data: prev.data, error: "", loading: true }));
    api<BuildCandidates>("/builds/candidates", {
      document_ids: draft.document_ids,
      ...(schemaKey ? { schema_key: schemaKey } : {}),
    })
      .then((data) => {
        if (!cancelled) setCandidates({ key: candidatesKey, data, error: "", loading: false });
      })
      .catch((failure) => {
        if (!cancelled) setCandidates({ key: candidatesKey, data: null, error: errorMessage(failure), loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidatesKey]);
  const current = candidates.key === candidatesKey ? candidates : null;
  const fieldsReady = !!(schemaKey && current && !current.loading && current.data);

  // 출력 설정: 필드 목록이 오면 저장된 설정과 합친다.
  const [columns, setColumns] = useState<ColumnConfig[]>([]);
  const [rowMode, setRowMode] = useState<RowMode>("record");
  useEffect(() => {
    if (!fieldsReady || !current?.data) return;
    const saved = readOutputConfig(schemaKey);
    setColumns(mergeColumns(current.data.fields || [], saved));
    setRowMode(saved?.row_mode || "record");
  }, [fieldsReady, current?.data, schemaKey]);
  const updateColumns = useCallback(
    (next: ColumnConfig[]) => {
      setColumns(next);
      writeOutputConfig(toOutputConfig(schemaKey, rowMode, next));
    },
    [schemaKey, rowMode],
  );
  const updateRowMode = useCallback(
    (next: RowMode) => {
      setRowMode(next);
      writeOutputConfig(toOutputConfig(schemaKey, next, columns));
    },
    [schemaKey, columns],
  );
  const errors = useMemo(() => headerErrors(columns), [columns]);
  const outputColumns = useMemo(() => toBuildColumns(columns), [columns]);
  const columnsValid = fieldsReady && outputColumns.length > 0 && Object.keys(errors).length === 0;

  // 단계 도달 조건.
  const usable = current?.data?.summary.usable ?? 0;
  const reachable = [true, draft.document_ids.length > 0 && usable > 0, !!schemaKey && usable > 0, columnsValid, columnsValid];
  const requested = Math.min(5, Math.max(1, Number(route.step) || 1));
  const pending = requested > 1 && !!candidatesKey && (!current || current.loading);
  let step = 1;
  for (let i = 0; i < requested; i++) if (reachable[i]) step = i + 1;
  const goStep = (n: number) => go({ step: n > 1 ? n : null });

  const schemas = useData<Page<SchemaRow>>(step >= 2 ? "/schemas" : null);
  const listedSchema = schemas.data?.items.find((s) => s.schema_key === schemaKey) || null;
  // 목록 기본은 활성만이다(§4.2.3). draft에 남아 있던 폐기 스키마는 상세를 한 번 읽어 이름·상태를 보이고 진행을 막지 않는다.
  const extraSchema = useData<SchemaRow>(schemaKey && schemas.data && !listedSchema ? "/schemas/" + encodeURIComponent(schemaKey) : null);
  const schemaRow = listedSchema || extraSchema.data;

  const input: BuildInput | null =
    columnsValid && schemaKey ? { document_ids: draft.document_ids, schema_key: schemaKey, columns: outputColumns, row_mode: rowMode } : null;

  function startOver() {
    clearBuildDraft();
    clearOutputConfig();
    setColumns([]);
    go({ step: null });
  }

  return (
    <>
      <Heading title="데이터 빌드" description="문서와 스키마를 선택하고 출력 Header를 정의한 뒤 미리보기 후 파일을 생성합니다." />
      <nav className="app-stepper" aria-label="빌드 단계">
        {BUILD_STEPS.map((label, i) => (
          <button
            key={label}
            type="button"
            data-step={i + 1}
            className={i + 1 < step ? "done" : undefined}
            aria-current={i + 1 === step ? "step" : undefined}
            disabled={!reachable[i] || pending}
            onClick={() => goStep(i + 1)}
          >
            {label}
          </button>
        ))}
      </nav>
      {pending ? (
        <section className="app-card">
          <p className="app-muted app-loading" role="status">
            불러오는 중…
          </p>
        </section>
      ) : step === 1 ? (
        <DocumentsStep
          draft={draft}
          candidates={current}
          onReselect={() => go({ screen: "documents", step: null })}
          onNext={() => goStep(2)}
          nextEnabled={reachable[1]}
        />
      ) : step === 2 ? (
        <SchemaStep
          schemas={schemas}
          schemaKey={schemaKey}
          unlisted={listedSchema ? null : extraSchema.data}
          candidates={current}
          onChange={(key) => setBuildDraftSchema(key || undefined)}
          onBack={() => goStep(1)}
          onNext={() => goStep(3)}
          nextEnabled={reachable[2] && fieldsReady}
        />
      ) : step === 3 ? (
        <BuildColumns
          columns={columns}
          errors={errors}
          usable={usable}
          rowMode={rowMode}
          onChange={updateColumns}
          onRowMode={updateRowMode}
          onBack={() => goStep(2)}
          onNext={() => goStep(4)}
          nextEnabled={columnsValid}
        />
      ) : (
        <BuildOutput
          step={step === 5 ? 5 : 4}
          input={input!}
          schema={schemaRow}
          onBack={() => goStep(step - 1)}
          onNext={() => goStep(5)}
          onStartOver={startOver}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- 1단계: 대상 문서

function DocumentsStep({
  draft,
  candidates,
  onReselect,
  onNext,
  nextEnabled,
}: {
  draft: { document_ids: string[] };
  candidates: Loaded<BuildCandidates> | null;
  onReselect: () => void;
  onNext: () => void;
  nextEnabled: boolean;
}) {
  if (draft.document_ids.length === 0)
    return (
      <section className="app-card">
        <EmptyState
          action={
            <button type="button" className="primary" onClick={onReselect}>
              문서 화면에서 선택
            </button>
          }
        >
          대상 문서가 없습니다. 문서 화면에서 문서를 선택해 데이터 빌드에 추가하세요.
        </EmptyState>
      </section>
    );
  const data = candidates?.data || null;
  const rows = (data?.documents || []).filter((d) => draft.document_ids.includes(d.document_id));
  return (
    <section className="app-card">
      <div className="app-card-head">
        <h2>
          입력 문서 {draft.document_ids.length}개
          {data ? ` · 사용 가능 ${data.summary.usable}개 · 제외 ${data.summary.excluded}개` : ""}
        </h2>
        <div className="app-inline">
          <button type="button" onClick={onReselect}>
            문서 다시 선택
          </button>
          <button type="button" onClick={clearBuildDraft}>
            비우기
          </button>
        </div>
      </div>
      {candidates?.loading && (
        <p className="app-muted app-loading" role="status">
          불러오는 중…
        </p>
      )}
      {candidates?.error && (
        <div className="app-error" role="alert">
          {candidates.error}
        </div>
      )}
      {data && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="대상 문서">
            <thead>
              <tr>
                <th scope="col">문서명</th>
                <th scope="col">사용 가능</th>
                <th scope="col">제외 사유</th>
                <th scope="col">프로파일</th>
                <th scope="col">
                  <span className="app-small">제거</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.document_id}>
                  <td>{d.document_name}</td>
                  <td>{d.usable ? <Chip kind="ok">사용 가능</Chip> : <Chip kind="muted">제외</Chip>}</td>
                  <td>{d.reason ? BUILD_REASON_LABELS[d.reason] || d.reason : ""}</td>
                  <td>{profileLabel(d.profile)}</td>
                  <td>
                    <button type="button" className="small" aria-label={`${d.document_name} 제거`} onClick={() => removeFromBuildDraft(d.document_id)}>
                      제거
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.summary.usable === 0 && (
        <p className="app-note">사용 가능한 문서가 없습니다. 문서 상태를 정상으로 만든 뒤 다시 추가하세요.</p>
      )}
      <div className="app-toolbar app-toolbar-end">
        <button type="button" className="primary" disabled={!nextEnabled} onClick={onNext}>
          다음: 스키마
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- 2단계: 스키마

function SchemaStep({
  schemas,
  schemaKey,
  unlisted,
  candidates,
  onChange,
  onBack,
  onNext,
  nextEnabled,
}: {
  schemas: { data: Page<SchemaRow> | null; loading: boolean; error: { message: string } | null };
  schemaKey: string;
  // 목록에 없는(폐기된) draft 스키마 — 있으면 선택지에 그대로 둔다.
  unlisted: SchemaRow | null;
  candidates: Loaded<BuildCandidates> | null;
  onChange: (key: string) => void;
  onBack: () => void;
  onNext: () => void;
  nextEnabled: boolean;
}) {
  const fields = schemaKey && candidates?.data && !candidates.loading ? candidates.data.fields || [] : null;
  return (
    <section className="app-card">
      <div className="app-card-head">
        <h2>파싱 스키마 선택</h2>
      </div>
      <p className="app-muted">출력할 필드를 정의한 파싱 스키마를 고릅니다. 필드마다 값이 있는 문서 수를 함께 보여줍니다.</p>
      {schemas.loading && (
        <p className="app-muted app-loading" role="status">
          불러오는 중…
        </p>
      )}
      {schemas.error && (
        <div className="app-error" role="alert">
          {schemas.error.message}
        </div>
      )}
      <div className="app-form">
        <label>
          파싱 스키마
          <select value={schemaKey} onChange={(e) => onChange(e.target.value)} disabled={!schemas.data}>
            <option value="">선택하세요</option>
            {(schemas.data?.items || []).map((s) => (
              <option key={s.schema_key} value={s.schema_key}>
                {schemaLabel(s)} · 필드 {s.field_count}개 · 프로파일 {s.profile_count}개 · 문서 {s.document_count}개
              </option>
            ))}
            {unlisted && (
              <option value={unlisted.schema_key}>
                {schemaLabel(unlisted)} · 필드 {unlisted.field_count}개 · 프로파일 {unlisted.profile_count}개 · 문서 {unlisted.document_count}개
              </option>
            )}
          </select>
        </label>
        {unlisted?.status === "deprecated" && (
          <span className="app-inline">
            <Chip kind="muted">폐기</Chip>
            <span className="app-muted app-small">폐기된 스키마입니다. 이미 고른 스키마라 그대로 쓸 수 있습니다.</span>
          </span>
        )}
      </div>
      {schemaKey && candidates?.loading && (
        <p className="app-muted app-loading" role="status">
          필드를 확인하는 중…
        </p>
      )}
      {candidates?.error && (
        <div className="app-error" role="alert">
          {candidates.error}
        </div>
      )}
      {fields && (
        <div className="app-stack">
          <p className="app-small">필드 {fields.length}개 · 값 있는 문서 수</p>
          <div className="app-chips" aria-label="필드 목록">
            {fields.map((f) => (
              <Chip key={f.field_key} kind={f.document_count > 0 ? "blue" : "muted"} title={f.unit ? `단위 ${f.unit}` : undefined}>
                {f.name} · {f.document_count}
              </Chip>
            ))}
          </div>
          {fields.length === 0 && <p className="app-note">이 스키마에는 필드가 없습니다.</p>}
        </div>
      )}
      <div className="app-toolbar app-toolbar-end">
        <button type="button" onClick={onBack}>
          이전
        </button>
        <button type="button" className="primary" disabled={!nextEnabled || !fields || fields.length === 0} onClick={onNext}>
          다음: 출력 설정
        </button>
      </div>
    </section>
  );
}
