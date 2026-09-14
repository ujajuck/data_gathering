// 문서 등록 대화상자(§7 Documents): GET /sources?directory= 폴더 탐색(체크박스) → POST /documents/register?wait=10
// {source_refs, provider} → 파일별 결과 행(등록 · 자동 적용 · 상태 · 실패 사유). 10초를 넘겨도 작업은 계속되고
// 대화상자를 닫으면 상단 JobBar(진행 중 작업)에서 이어서 볼 수 있다.
// 폴더 일괄 등록(§4.1.1): 파일을 하나씩 고르는 대신 폴더 하나를 지정한다. 툴바 '이 폴더 전체 등록'(최상위는
// '원본 폴더 전체 등록')과 폴더 행의 '전체 등록' → GET /sources/scan?directory= 미리보기(호출 1회, Reader 없이
// stat·해시 캐시만 쓰므로 큰 폴더도 빠르다) → POST /documents/register-directory?wait=10. 변경 없는 문서는
// 기본으로 건너뛰므로 같은 폴더를 다시 돌려도 싸다.
import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { State, isJobActive, useData, useJob, useToast, withQuery } from "./client";
import type { ChipClass, Page, RegisterResult, RegisterSummary, SourceEntry, SourceScan } from "./types";
import { Chip, EmptyState, Modal, StatusChip } from "./ui";
import { SCAN_STATE_CLASS, SCAN_STATE_LABELS, compatibilityLabel, registerSummaryText } from "./types";

export const REGISTER_PROVIDER = "local-xlsx";

const parentOf = (directory: string) => directory.split("/").filter(Boolean).slice(0, -1).join("/");
const fileName = (ref: string) => ref.split("/").filter(Boolean).pop() || ref;

function formatSize(size: number | null | undefined): string {
  if (!size && size !== 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export default function DocumentRegister({ onClose, onRegistered }: { onClose: () => void; onRegistered: () => void }) {
  const { notify } = useToast();
  const [directory, setDirectory] = useState("");
  const [directoryInput, setDirectoryInput] = useState("");
  // source_ref → 표시 이름. 폴더를 오가도 선택은 유지된다.
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [submitted, setSubmitted] = useState<string[]>([]);
  // 폴더 일괄 등록 미리보기 대상. null이면 파일 고르기 화면이다.
  const [scanned, setScanned] = useState<string | null>(null);
  const [includeUnchanged, setIncludeUnchanged] = useState(false);
  const job = useJob();
  const sources = useData<Page<SourceEntry> | SourceEntry[]>(withQuery("/sources", { directory }));
  // 미리보기는 폴더당 한 번만 읽는다(GET 60초 캐시 + 진행 중 요청 공유).
  const scan = useData<SourceScan>(scanned === null ? null : withQuery("/sources/scan", { directory: scanned }));
  const entries = Array.isArray(sources.data) ? sources.data : sources.data?.items ?? [];
  const folders = entries.filter((e) => e.directory);
  const files = entries.filter((e) => !e.directory);
  const allChecked = files.length > 0 && files.every((f) => selected.has(f.source_ref));
  const preview = scan.data;
  // 체크박스는 재조회 없이 로컬에서 계산한다: 기본은 targeted, 켜면 변경 없음·잠김까지.
  const targetCount = preview
    ? preview.targeted + (includeUnchanged ? preview.states.unchanged + preview.states.locked : 0)
    : 0;

  function open(next: string) {
    setDirectory(next);
    setDirectoryInput(next);
  }
  function onDirectoryKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      open(directoryInput.trim());
    }
  }
  function openScan(next: string) {
    job.reset(); // 직전 단일 등록의 실패 메시지를 폴더 미리보기로 끌고 가지 않는다
    setIncludeUnchanged(false);
    setScanned(next);
  }
  function backToFiles() {
    setScanned(null);
    job.reset();
  }
  function toggle(entry: SourceEntry, checked: boolean) {
    setSelected((map) => {
      const next = new Map(map);
      if (checked) next.set(entry.source_ref, entry.name);
      else next.delete(entry.source_ref);
      return next;
    });
  }
  function toggleAll(checked: boolean) {
    setSelected((map) => {
      const next = new Map(map);
      files.forEach((f) => (checked ? next.set(f.source_ref, f.name) : next.delete(f.source_ref)));
      return next;
    });
  }
  async function submit() {
    const refs = [...selected.keys()];
    setSubmitted(refs);
    const result = await job.run("/documents/register", { source_refs: refs, provider: REGISTER_PROVIDER }, 10);
    if (!result) return;
    onRegistered();
    if (result.state === "succeeded") {
      const documents = (result.result as RegisterResult | null)?.documents ?? [];
      const failed = documents.filter((d) => d.error).length;
      notify(failed ? `${documents.length - failed}개 문서 등록 · ${failed}개 실패` : `${documents.length}개 문서를 등록했습니다.`);
    }
  }
  async function submitDirectory() {
    const result = await job.run(
      "/documents/register-directory",
      { directory: scanned ?? "", provider: REGISTER_PROVIDER, include_unchanged: includeUnchanged },
      10,
    );
    if (!result) return;
    onRegistered();
    if (result.state === "succeeded") {
      const summary = (result.result as RegisterResult | null)?.summary;
      const registered = summary?.registered ?? 0;
      const failed = summary?.failed ?? 0;
      notify(failed ? `${registered}개 문서 등록 · ${failed}개 실패` : `${registered}개 문서를 등록했습니다.`);
    }
  }
  function again() {
    job.reset();
    setSubmitted([]);
    setSelected(new Map());
    setScanned(null);
    setIncludeUnchanged(false);
  }

  const finished = job.job && !isJobActive(job.job);
  const running = job.job && isJobActive(job.job);
  const result = finished && job.job?.state === "succeeded" ? (job.job.result as RegisterResult | null) : null;
  const results = result ? result.documents ?? [] : null;
  // 미리보기에서 시작한 작업인지(진행·결과 문구가 다르다).
  const directoryMode = scanned !== null;

  return (
    <Modal
      label="문서 등록"
      title="문서 등록"
      className="center"
      onClose={onClose}
      // 화면(파일 고르기 ↔ 폴더 미리보기 ↔ 진행 ↔ 결과)이 바뀌면 초점을 대화상자로 되돌린다.
      viewKey={results ? "results" : finished ? "failed" : running ? "running" : directoryMode ? "scan" : "files"}
      actions={
        results || (finished && job.job?.state !== "succeeded") ? (
          <>
            <button type="button" className="primary" onClick={onClose}>
              닫기
            </button>
            <button type="button" onClick={again}>
              추가 등록
            </button>
          </>
        ) : directoryMode ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={job.busy || scan.loading || !!scan.error || targetCount === 0}
              onClick={submitDirectory}
            >
              {job.busy ? "등록 중…" : preview ? `${targetCount}개 등록 시작` : "등록 시작"}
            </button>
            {!running && (
              <button type="button" onClick={backToFiles}>
                파일 고르기로 돌아가기
              </button>
            )}
            <button type="button" onClick={onClose}>
              닫기
            </button>
          </>
        ) : (
          <>
            <button type="button" className="primary" disabled={selected.size === 0 || job.busy} onClick={submit}>
              {job.busy ? "등록 중…" : selected.size > 0 ? `${selected.size}개 문서 등록` : "문서 등록"}
            </button>
            <button type="button" onClick={onClose}>
              {running ? "닫기" : "취소"}
            </button>
          </>
        )
      }
    >
      {results ? (
        <RegisterResults documents={results} summary={result?.summary} truncated={result?.truncated} />
      ) : finished ? (
        <div className="app-error" role="alert">
          <span>등록 작업이 실패했습니다: {job.job?.error_message || job.job?.error_code || "알 수 없는 오류"}</span>
        </div>
      ) : running ? (
        <div className="app-stack">
          <p className="app-note" role="status">
            {directoryMode ? "폴더 일괄 등록 진행 중" : "등록 작업이 진행 중입니다"}
            {job.job?.total ? ` (${job.job.completed}/${job.job.total})` : ""}. 10초 안에 끝나지 않아 계속 기다리는 중이며, 닫아도 상단의
            진행 중 작업 표시에서 확인할 수 있습니다.
          </p>
          {!directoryMode && (
            <ul className="app-plain-list" aria-label="등록 중인 문서">
              {submitted.map((ref) => (
                <li key={ref}>{selected.get(ref) || fileName(ref)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : directoryMode ? (
        <div className="app-stack">
          <State resource={scan} />
          {preview && (
            <>
              <p>
                <strong>
                  {scanned ? `${scanned}/ 아래` : "원본 폴더 아래"} 파일 {preview.files}개 · 하위 폴더 {preview.folders}개
                </strong>
              </p>
              <span className="app-chips" aria-label="스캔 요약">
                {stateChips(preview).map(([label, count, kind]) => (
                  // 0인 항목은 색을 빼서 눈에 띄지 않게 한다.
                  <Chip key={label} kind={count ? kind : "muted"}>
                    {label} {count}
                  </Chip>
                ))}
              </span>
              <SkippedNote scan={preview} />
              <label className="app-inline">
                <input type="checkbox" checked={includeUnchanged} onChange={(e) => setIncludeUnchanged(e.target.checked)} />
                변경 없는 문서·잠긴 문서도 다시 읽기
              </label>
              {targetCount === 0 && (
                <p className="app-note">
                  등록할 새 파일이나 변경된 문서가 없습니다.
                  {preview.states.unchanged + preview.states.locked > 0 ? " 다시 읽으려면 위 상자를 켜세요." : ""}
                </p>
              )}
              {preview.sample.length > 0 && (
                <details>
                  <summary className="app-small">예시 파일 {preview.sample.length}개 보기</summary>
                  <ul className="app-plain-list" aria-label="예시 파일">
                    {preview.sample.map((item) => (
                      <li key={item.source_ref} className="app-inline">
                        <span>{fileName(item.source_ref)}</span>
                        <Chip kind={SCAN_STATE_CLASS[item.state] || "muted"}>{SCAN_STATE_LABELS[item.state] || item.state}</Chip>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          {scan.error?.code === "DIRECTORY_LIMIT" && (
            <p className="app-muted app-small">파일 고르기로 돌아가 하위 폴더를 하나씩 지정하면 나누어 등록할 수 있습니다.</p>
          )}
          {job.error && (
            <div className="app-error" role="alert">
              <span>{job.error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="app-stack">
          <p className="app-muted app-small">
            원본 폴더에서 등록할 파일을 고르세요. 폴더 하나를 통째로 넣으려면 '이 폴더 전체 등록'을 누르면 됩니다(하위 폴더까지
            한 번에). 등록과 함께 맞는 파싱 프로파일이 자동으로 적용됩니다.
          </p>
          <div className="app-toolbar">
            <label className="app-grow">
              폴더
              <input
                value={directoryInput}
                placeholder="원본 폴더(비우면 최상위)"
                onChange={(e) => setDirectoryInput(e.target.value)}
                onKeyDown={onDirectoryKey}
              />
            </label>
            <button type="button" className="small" onClick={() => open(directoryInput.trim())}>
              이동
            </button>
            <button type="button" className="small" disabled={!directory} onClick={() => open(parentOf(directory))}>
              상위 폴더
            </button>
            <span className="app-toolbar-end">
              <button type="button" className="small secondary" onClick={() => openScan(directory)}>
                {directory ? "이 폴더 전체 등록" : "원본 폴더 전체 등록"}
              </button>
            </span>
          </div>
          {job.error && (
            <div className="app-error" role="alert">
              <span>{job.error}</span>
            </div>
          )}
          <State resource={{ ...sources, data: entries }} empty="이 폴더에는 등록할 파일이 없습니다." />
          {entries.length > 0 && (
            <div className="app-table-wrap">
              <table className="app-table" aria-label="원본 파일 목록">
                <thead>
                  <tr>
                    <th scope="col">
                      <input type="checkbox" aria-label="폴더 전체 선택" checked={allChecked} disabled={files.length === 0} onChange={(e) => toggleAll(e.target.checked)} />
                    </th>
                    <th scope="col">이름</th>
                    <th scope="col">크기</th>
                    <th scope="col">수정</th>
                  </tr>
                </thead>
                <tbody>
                  {folders.map((folder) => (
                    <tr key={"d:" + folder.source_ref} className="clickable" onClick={() => open(folder.source_ref)}>
                      <td></td>
                      <td>
                        <button type="button" className="link" onClick={(e) => { e.stopPropagation(); open(folder.source_ref); }}>
                          📁 {folder.name}
                        </button>
                      </td>
                      <td className="app-muted">폴더</td>
                      <td>
                        <button
                          type="button"
                          className="small"
                          aria-label={`${folder.name} 전체 등록`}
                          onClick={(e) => { e.stopPropagation(); openScan(folder.source_ref); }}
                        >
                          전체 등록
                        </button>
                      </td>
                    </tr>
                  ))}
                  {files.map((file) => (
                    <tr key={"f:" + file.source_ref} className={selected.has(file.source_ref) ? "selected" : ""}>
                      <td>
                        <input type="checkbox" aria-label={file.name} checked={selected.has(file.source_ref)} onChange={(e) => toggle(file, e.target.checked)} />
                      </td>
                      <td>{file.name}</td>
                      <td className="num">{formatSize(file.size)}</td>
                      <td className="app-muted">{file.modified_at ? file.modified_at.slice(0, 10) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selected.size > 0 && (
            <div className="app-selection-bar">
              <span>{selected.size}개 선택</span>
              <span className="app-chips" aria-label="선택한 파일">
                {[...selected.entries()].map(([ref, name]) => (
                  <button key={ref} type="button" className="app-chip blue" aria-label={`${name} 선택 해제`} onClick={() => setSelected((map) => { const next = new Map(map); next.delete(ref); return next; })}>
                    {name} ×
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

// 미리보기 칩(§7): 새 파일 · 변경된 문서 · 변경 없음 · 잠김.
function stateChips(scan: SourceScan): [string, number, ChipClass][] {
  return [
    ["새 파일", scan.states.new, "ok"],
    ["변경된 문서", scan.states.changed, "warn"],
    ["변경 없음", scan.states.unchanged, "muted"],
    ["잠김", scan.states.locked, "err"],
  ];
}

// 건너뛴 항목(§4.1.1 skipped). 0인 항목은 적지 않고, 전부 0이면 줄 자체를 숨긴다.
function SkippedNote({ scan }: { scan: SourceScan }) {
  const parts: string[] = [];
  if (scan.skipped.temp) parts.push(`임시 파일 ${scan.skipped.temp}`);
  if (scan.skipped.unsupported) parts.push(`지원하지 않는 파일 ${scan.skipped.unsupported}`);
  if (scan.skipped.symlink) parts.push(`링크 ${scan.skipped.symlink}`);
  if (!parts.length) return null;
  return <p className="app-muted app-small">건너뜀: {parts.join(" · ")}</p>;
}

function RegisterResults({
  documents,
  summary,
  truncated,
}: {
  documents: RegisterResult["documents"];
  summary?: RegisterSummary;
  truncated?: boolean;
}) {
  if (!summary && documents.length === 0) return <EmptyState>등록된 문서가 없습니다.</EmptyState>;
  return (
    <div className="app-stack">
      <p className="app-muted app-small">
        {summary
          ? registerSummaryText(summary)
          : `${documents.length}개 중 ${documents.filter((d) => !d.error).length}개 등록 · ${documents.filter((d) => d.error).length}개 실패`}
      </p>
      {truncated && <p className="app-note">앞 500개만 표시 — 나머지는 문서 화면에서 확인하세요</p>}
      {documents.length === 0 ? (
        <EmptyState>등록된 문서가 없습니다.</EmptyState>
      ) : (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="등록 결과">
            <thead>
              <tr>
                <th scope="col">문서명</th>
                <th scope="col">등록</th>
                <th scope="col">자동 적용</th>
                <th scope="col">상태</th>
                <th scope="col">실패 사유</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d, i) => (
                <tr key={d.document_id || d.source_ref || i}>
                  <td title={d.source_ref || undefined}>{d.document_name}</td>
                  <td>{d.error ? <Chip kind="err">실패</Chip> : <Chip kind="ok">완료</Chip>}</td>
                  <td>
                    {d.applied?.length ? (
                      d.applied.map((a) => `${a.profile_name} · ${compatibilityLabel(a.compatibility)}`).join(", ")
                    ) : (
                      <span className="app-muted">없음</span>
                    )}
                  </td>
                  <td>{d.status ? <StatusChip status={d.status} /> : <span className="app-muted">-</span>}</td>
                  <td className="app-wrap">{d.error?.message || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
