// 문서 등록 대화상자(§7 Documents): GET /sources?directory= 폴더 탐색(체크박스) → POST /documents/register?wait=10
// {source_refs, provider} → 파일별 결과 행(등록 · 자동 적용 · 상태 · 실패 사유). 10초를 넘겨도 작업은 계속되고
// 대화상자를 닫으면 상단 JobBar(진행 중 작업)에서 이어서 볼 수 있다.
import { useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { State, isJobActive, useData, useJob, useToast, withQuery } from "./client";
import type { Page, RegisterResult, SourceEntry } from "./types";
import { Chip, EmptyState, Modal, StatusChip } from "./ui";
import { compatibilityLabel } from "./types";

export const REGISTER_PROVIDER = "local-xlsx";

const parentOf = (directory: string) => directory.split("/").filter(Boolean).slice(0, -1).join("/");

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
  const job = useJob();
  const sources = useData<Page<SourceEntry> | SourceEntry[]>(withQuery("/sources", { directory }));
  const entries = Array.isArray(sources.data) ? sources.data : sources.data?.items ?? [];
  const folders = entries.filter((e) => e.directory);
  const files = entries.filter((e) => !e.directory);
  const allChecked = files.length > 0 && files.every((f) => selected.has(f.source_ref));

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
  function again() {
    job.reset();
    setSubmitted([]);
    setSelected(new Map());
  }

  const finished = job.job && !isJobActive(job.job);
  const running = job.job && isJobActive(job.job);
  const results = finished && job.job?.state === "succeeded" ? ((job.job.result as RegisterResult | null)?.documents ?? []) : null;

  return (
    <Modal
      label="문서 등록"
      title="문서 등록"
      className="center"
      onClose={onClose}
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
        <RegisterResults documents={results} />
      ) : finished ? (
        <div className="v3-error" role="alert">
          <span>등록 작업이 실패했습니다: {job.job?.error_message || job.job?.error_code || "알 수 없는 오류"}</span>
        </div>
      ) : running ? (
        <div className="v3-stack">
          <p className="v3-note" role="status">
            등록 작업이 진행 중입니다
            {job.job?.total ? ` (${job.job.completed}/${job.job.total})` : ""}. 10초 안에 끝나지 않아 계속 기다리는 중이며, 닫아도 상단의
            진행 중 작업 표시에서 확인할 수 있습니다.
          </p>
          <ul className="v3-plain-list" aria-label="등록 중인 문서">
            {submitted.map((ref) => (
              <li key={ref}>{selected.get(ref) || ref.split("/").pop()}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="v3-stack">
          <p className="v3-muted v3-small">원본 폴더에서 등록할 파일을 고르세요. 등록과 함께 맞는 파싱 프로파일이 자동으로 적용됩니다.</p>
          <div className="v3-toolbar">
            <label className="v3-grow">
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
          </div>
          {job.error && (
            <div className="v3-error" role="alert">
              <span>{job.error}</span>
            </div>
          )}
          <State resource={{ ...sources, data: entries }} empty="이 폴더에는 등록할 파일이 없습니다." />
          {entries.length > 0 && (
            <div className="v3-table-wrap">
              <table className="v3-table" aria-label="원본 파일 목록">
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
                      <td className="v3-muted">폴더</td>
                      <td></td>
                    </tr>
                  ))}
                  {files.map((file) => (
                    <tr key={"f:" + file.source_ref} className={selected.has(file.source_ref) ? "selected" : ""}>
                      <td>
                        <input type="checkbox" aria-label={file.name} checked={selected.has(file.source_ref)} onChange={(e) => toggle(file, e.target.checked)} />
                      </td>
                      <td>{file.name}</td>
                      <td className="num">{formatSize(file.size)}</td>
                      <td className="v3-muted">{file.modified_at ? file.modified_at.slice(0, 10) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selected.size > 0 && (
            <div className="v3-selection-bar">
              <span>{selected.size}개 선택</span>
              <span className="v3-chips" aria-label="선택한 파일">
                {[...selected.entries()].map(([ref, name]) => (
                  <button key={ref} type="button" className="v3-chip blue" aria-label={`${name} 선택 해제`} onClick={() => setSelected((map) => { const next = new Map(map); next.delete(ref); return next; })}>
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

function RegisterResults({ documents }: { documents: RegisterResult["documents"] }) {
  if (documents.length === 0) return <EmptyState>등록된 문서가 없습니다.</EmptyState>;
  return (
    <div className="v3-stack">
      <p className="v3-muted v3-small">
        {documents.length}개 중 {documents.filter((d) => !d.error).length}개 등록 · {documents.filter((d) => d.error).length}개 실패
      </p>
      <div className="v3-table-wrap">
        <table className="v3-table" aria-label="등록 결과">
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
              <tr key={d.document_id || i}>
                <td>{d.document_name}</td>
                <td>{d.error ? <Chip kind="err">실패</Chip> : <Chip kind="ok">완료</Chip>}</td>
                <td>
                  {d.applied?.length ? (
                    d.applied.map((a) => `${a.profile_name} · ${compatibilityLabel(a.compatibility)}`).join(", ")
                  ) : (
                    <span className="v3-muted">없음</span>
                  )}
                </td>
                <td>{d.status ? <StatusChip status={d.status} /> : <span className="v3-muted">-</span>}</td>
                <td className="v3-wrap">{d.error?.message || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
