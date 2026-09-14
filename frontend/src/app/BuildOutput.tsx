// 데이터 빌드 4·5단계: 미리보기(POST /builds/preview, 최대 50행, 셀마다 원본 보기) → 생성(CSV/XLSX/SQLite,
// POST /builds?wait=30; 긴 빌드는 useJob으로 작업 상태를 폴링) → 결과 카드(다운로드 · manifest 보기 · 새 빌드).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, downloadFile, errorMessage, isJobActive, profileLabel, regionLabel, reviewRoute, schemaLabel, useJob, useNavigation, useToast } from "./client";
import type { BuildCandidate, BuildConflict, BuildFormat, BuildManifest, BuildPreview, BuildResult, JobResponse, PreviewCell, PreviewRow, SchemaRow } from "./types";
import { BUILD_REASON_LABELS, JOB_STATE_LABELS } from "./types";
import { Chip, EmptyState } from "./ui";
import type { BuildInput } from "./Build";

export const FORMAT_LABELS: Record<BuildFormat, string> = { csv: "CSV", xlsx: "XLSX", sqlite: "SQLite" };
const FORMATS: BuildFormat[] = ["csv", "xlsx", "sqlite"];

type Loaded<T> = { key: string; data: T | null; error: string; loading: boolean };

export default function BuildOutput({
  step,
  input,
  schema,
  onBack,
  onNext,
  onStartOver,
}: {
  step: 4 | 5;
  input: BuildInput;
  schema: SchemaRow | null;
  onBack: () => void;
  onNext: () => void;
  onStartOver: () => void;
}) {
  const requestKey = JSON.stringify(input);
  const [preview, setPreview] = useState<Loaded<BuildPreview>>({ key: "", data: null, error: "", loading: false });
  useEffect(() => {
    if (step !== 4 || preview.key === requestKey) return;
    let cancelled = false;
    setPreview({ key: requestKey, data: null, error: "", loading: true });
    api<BuildPreview>("/builds/preview", input)
      .then((data) => {
        if (!cancelled) setPreview({ key: requestKey, data, error: "", loading: false });
      })
      .catch((failure) => {
        if (!cancelled) setPreview({ key: requestKey, data: null, error: errorMessage(failure), loading: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, requestKey]);

  if (step === 4)
    return (
      <PreviewStep
        preview={preview.key === requestKey ? preview : null}
        input={input}
        onRetry={() => setPreview({ key: "", data: null, error: "", loading: false })}
        onBack={onBack}
        onNext={onNext}
      />
    );
  return <GenerateStep input={input} schema={schema} onBack={onBack} onStartOver={onStartOver} />;
}

// ---------------------------------------------------------------- 4단계: 미리보기

function PreviewStep({
  preview,
  input,
  onRetry,
  onBack,
  onNext,
}: {
  preview: Loaded<BuildPreview> | null;
  input: BuildInput;
  onRetry: () => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { go } = useNavigation();
  const data = preview?.data || null;
  const headers = data?.columns?.length ? data.columns : input.columns;
  // 행은 {cells[]} 객체(백엔드) 또는 셀 배열 — 둘 다 셀 배열로 편다.
  const rows = (data?.rows || []).slice(0, 50).map((row) => cellsOf(row));
  const openSource = (cell: NonNullable<PreviewCell>) =>
    cell.application_id && go(reviewRoute({ application_id: cell.application_id, rule_key: cell.rule_key, sheet_id: cell.sheet_id, range: cell.range }));
  return (
    <section className="app-card">
      <div className="app-card-head">
        <h2>미리보기</h2>
        {data && (
          <span className="app-small">
            총 {data.row_count}행 · 표시 {rows.length}행(최대 50행)
          </span>
        )}
      </div>
      {preview?.loading && (
        <p className="app-muted app-loading" role="status">
          미리보기를 만드는 중…
        </p>
      )}
      {preview?.error && (
        <div className="app-error" role="alert">
          <span>{preview.error}</span>
          <button type="button" className="small" onClick={onRetry}>
            다시 시도
          </button>
        </div>
      )}
      {data && rows.length === 0 && (
        <EmptyState>표시할 행이 없습니다. 사용 가능한 문서와 선택한 필드에 추출된 값이 있는지 확인하세요.</EmptyState>
      )}
      {data && rows.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table app-build-preview" aria-label="미리보기">
            <thead>
              <tr>
                <th scope="col">#</th>
                {headers.map((c) => (
                  <th key={c.field_key} scope="col">
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  <td className="num">{r + 1}</td>
                  {headers.map((c, i) => {
                    const cell = row[i];
                    return (
                      <td key={c.field_key}>
                        {cell ? (
                          <span className="app-build-cell">
                            <span>{cell.text}</span>
                            {cell.application_id && (
                              <button
                                type="button"
                                className="link small"
                                aria-label={`${c.header} ${r + 1}행 원본 보기`}
                                title={regionLabel(cell.sheet_name, cell.range)}
                                onClick={() => openSource(cell)}
                              >
                                원본 보기
                              </button>
                            )}
                          </span>
                        ) : (
                          <span className="app-muted">-</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <ExcludedAndConflicts excluded={data.excluded} conflicts={data.conflicts} />}
      <div className="app-toolbar app-toolbar-end">
        <button type="button" onClick={onBack}>
          이전
        </button>
        <button type="button" className="primary" disabled={!data} onClick={onNext}>
          다음: 생성
        </button>
      </div>
    </section>
  );
}

function cellsOf(row: PreviewRow | PreviewCell[]): PreviewCell[] {
  if (Array.isArray(row)) return row;
  return Array.isArray(row?.cells) ? row.cells : [];
}

function ExcludedAndConflicts({ excluded, conflicts }: { excluded: BuildCandidate[]; conflicts: BuildConflict[] }) {
  if (!excluded?.length && !conflicts?.length) return null;
  return (
    <div className="app-stack">
      {excluded?.length > 0 && (
        <section aria-label="제외 문서">
          <h3 className="app-small">제외 문서 {excluded.length}개</h3>
          <ul className="app-list">
            {excluded.map((d) => (
              <li key={d.document_id} className="app-list-item">
                <span>{d.document_name}</span>
                <Chip kind="muted">{d.reason ? BUILD_REASON_LABELS[d.reason] || d.reason : "제외"}</Chip>
              </li>
            ))}
          </ul>
        </section>
      )}
      {conflicts?.length > 0 && (
        <section aria-label="충돌">
          <h3 className="app-small">충돌 {conflicts.length}건 · 첫 값을 사용합니다</h3>
          <ul className="app-list">
            {conflicts.map((c, i) => (
              <li key={i} className="app-list-item">
                <span>
                  {c.document_name} · {c.field_key}
                  {c.reason ? ` · ${c.reason}` : ""}
                </span>
                <span className="app-small app-muted">{(c.values || []).join(" / ")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 5단계: 생성

// POST /builds 응답은 동기면 BuildResult, 비동기면 JobResponse(완료 시 result에 build_key).
function resultOf(response: JobResponse | BuildResult): BuildResult | null {
  if ("build_key" in response && response.build_key) return response as BuildResult;
  const job = response as JobResponse;
  const result = (job.result || {}) as Partial<BuildResult>;
  if (job.state === "succeeded" && result.build_key)
    return {
      build_key: result.build_key,
      download_url: result.download_url || `/builds/${encodeURIComponent(result.build_key)}/download`,
      manifest: result.manifest as BuildManifest,
    };
  return null;
}

function GenerateStep({
  input,
  schema,
  onBack,
  onStartOver,
}: {
  input: BuildInput;
  schema: SchemaRow | null;
  onBack: () => void;
  onStartOver: () => void;
}) {
  const runner = useJob(1000);
  const toast = useToast();
  const [format, setFormat] = useState<BuildFormat>("xlsx");
  const [result, setResult] = useState<{ format: BuildFormat; value: BuildResult } | null>(null);
  const [error, setError] = useState("");
  const [manifest, setManifest] = useState<Loaded<BuildManifest>>({ key: "", data: null, error: "", loading: false });
  const [downloading, setDownloading] = useState(false);
  const activeJob = isJobActive(runner.job) ? runner.job : null;

  async function generate() {
    setError("");
    setResult(null);
    setManifest({ key: "", data: null, error: "", loading: false });
    const response = await runner.run("/builds", { ...input, format }, 30);
    if (!response) return;
    const value = resultOf(response);
    if (value) {
      setResult({ format, value });
      toast.notify(`데이터 빌드 완료 · ${FORMAT_LABELS[format]}`);
      return;
    }
    const job = response as JobResponse;
    setError(job.error_message || (job.state ? `빌드가 ${JOB_STATE_LABELS[job.state] || job.state} 상태로 끝났습니다.` : "빌드 결과를 받지 못했습니다."));
  }
  async function download() {
    if (!result) return;
    setDownloading(true);
    try {
      await downloadFile(result.value.download_url, `data.${result.format}`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setDownloading(false);
    }
  }
  async function showManifest() {
    if (!result) return;
    const key = result.value.build_key;
    if (manifest.key === key && manifest.data) return;
    setManifest({ key, data: null, error: "", loading: true });
    try {
      const data = await api<BuildManifest>(`/builds/${encodeURIComponent(key)}/manifest`);
      setManifest({ key, data, error: "", loading: false });
    } catch (failure) {
      setManifest({ key, data: null, error: errorMessage(failure), loading: false });
    }
  }

  return (
    <section className="app-card">
      <div className="app-card-head">
        <h2>생성</h2>
        <span className="app-small">
          문서 {input.document_ids.length}개 · 컬럼 {input.columns.length}개{schema ? ` · ${schemaLabel(schema)}` : ""}
        </span>
      </div>
      <div className="app-form">
        <fieldset className="app-fieldset">
          <legend>출력 형식</legend>
          <div className="app-inline" role="radiogroup" aria-label="출력 형식">
            {FORMATS.map((f) => (
              <label key={f} className="app-check">
                <input type="radio" name="app-build-format" value={f} checked={format === f} disabled={runner.busy} onChange={() => setFormat(f)} />
                {FORMAT_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {(error || runner.error) && (
        <div className="app-error" role="alert">
          {error || runner.error}
        </div>
      )}
      {runner.busy && (
        <div className="app-inline" role="status">
          <span>
            빌드 진행 중…{activeJob ? ` ${JOB_STATE_LABELS[activeJob.state]}` : ""}
            {activeJob?.total ? ` ${activeJob.completed}/${activeJob.total}` : ""}
          </span>
          {activeJob && (
            <button type="button" className="small" onClick={runner.cancel}>
              취소
            </button>
          )}
        </div>
      )}
      {result && (
        <ResultCard
          result={result.value}
          format={result.format}
          schema={schema}
          manifest={manifest}
          downloading={downloading}
          onDownload={download}
          onManifest={showManifest}
          onStartOver={onStartOver}
        />
      )}
      <div className="app-toolbar app-toolbar-end">
        <button type="button" disabled={runner.busy} onClick={onBack}>
          이전
        </button>
        <button type="button" className="primary" disabled={runner.busy} onClick={generate}>
          {result ? "다시 생성" : "파일 생성"}
        </button>
      </div>
    </section>
  );
}

function ResultCard({
  result,
  format,
  schema,
  manifest,
  downloading,
  onDownload,
  onManifest,
  onStartOver,
}: {
  result: BuildResult;
  format: BuildFormat;
  schema: SchemaRow | null;
  manifest: Loaded<BuildManifest>;
  downloading: boolean;
  onDownload: () => void;
  onManifest: () => void;
  onStartOver: () => void;
}) {
  const summary = manifest.data || result.manifest || null;
  return (
    <section className="app-card tight app-build-result" aria-label="빌드 결과">
      <div className="app-card-head">
        <h3>
          <Chip kind="ok">완료</Chip> data.{format}
        </h3>
        <span className="app-small">
          {summary ? `행 ${summary.row_count}개 · 컬럼 ${summary.columns?.length ?? 0}개 · 원본 문서 ${summary.sources?.length ?? 0}개` : ""}
        </span>
      </div>
      <div className="app-inline">
        <button type="button" className="primary" disabled={downloading} onClick={onDownload}>
          다운로드
        </button>
        <button type="button" onClick={onManifest} disabled={manifest.loading}>
          manifest 보기
        </button>
        <button type="button" className="secondary" onClick={onStartOver}>
          새 빌드
        </button>
      </div>
      {manifest.loading && (
        <p className="app-muted app-loading" role="status">
          불러오는 중…
        </p>
      )}
      {manifest.error && (
        <div className="app-error" role="alert">
          {manifest.error}
        </div>
      )}
      {manifest.data && <ManifestSummary manifest={manifest.data} schema={schema} />}
    </section>
  );
}

function ManifestSummary({ manifest, schema }: { manifest: BuildManifest; schema: SchemaRow | null }) {
  const schemaText = schema
    ? schemaLabel({ schema_name: schema.schema_name, rev: manifest.schema?.rev ?? schema.current_rev })
    : manifest.schema
      ? `v${manifest.schema.rev}`
      : "-";
  const item = (label: string, value: ReactNode) => (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  return (
    <div className="app-stack" aria-label="manifest 요약">
      <dl className="app-kv">
        {item("원본 문서", `${manifest.sources?.length ?? 0}개`)}
        {item("컬럼", `${manifest.columns?.length ?? 0}개`)}
        {item("행", `${manifest.row_count}행`)}
        {item("행 구성", manifest.row_mode === "document" ? "문서마다 1행" : "레코드마다 1행")}
        {item("스키마", schemaText)}
        {item("제외", `${manifest.excluded?.length ?? 0}개`)}
        {item("충돌", `${manifest.conflicts?.length ?? 0}건`)}
      </dl>
      {(manifest.columns?.length ?? 0) > 0 && (
        <div className="app-chips" aria-label="출력 컬럼">
          {manifest.columns.map((c) => (
            <Chip key={c.field_key} kind="blue" title={c.field_key}>
              {c.header}
              {c.unit ? ` (${c.unit})` : ""}
            </Chip>
          ))}
        </div>
      )}
      {(manifest.sources?.length ?? 0) > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="원본 문서">
            <thead>
              <tr>
                <th scope="col">문서명</th>
                <th scope="col">프로파일</th>
              </tr>
            </thead>
            <tbody>
              {manifest.sources.map((s) => (
                <tr key={s.document_id + s.application_id}>
                  <td>{s.document_name}</td>
                  <td>{profileLabel(s.profile ? { profile_name: s.profile.name, rev: s.profile.rev } : null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
