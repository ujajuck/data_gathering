// 작업 내역 화면(§7 Jobs · ui-development-spec §7): 렌더 서버 상태 한 줄 + 요약 카드(GET /queues) + 큐 패널(JobsQueue) +
// 작업 목록(GET /jobs keyset, 종류·상태 필터, 실패 행은 target_kind별 이동, 대기·진행 중은 취소). 진입 호출: /queues ·
// /queues/{kind} · /jobs(/status는 쉘의 캐시 공유). 진행 중 작업이 있는 동안 3초마다 조용히 다시 받는다.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PAGE_LIMIT,
  Pager,
  State,
  api,
  errorMessage,
  formatDateTime,
  isJobActive,
  jobLabel,
  reviewRoute,
  useData,
  useNavigation,
  usePage,
  useToast,
  useWriteSeq,
  withQuery,
} from "./client";
import type { JobResponse, JobState, Page, QueueKind, QueueSummary, StatusResponse } from "./types";
import { JOB_KIND_LABELS, JOB_STATE_LABELS, QUEUE_LABELS } from "./types";
import { Chip, Heading } from "./ui";
import QueuePanel, { QUEUE_ORDER, QueueActionDialog, resultSummary } from "./JobsQueue";
import type { DialogRequest } from "./JobsQueue";

const POLL_MS = 3000;
const STATE_CLASS: Record<JobState, "ok" | "warn" | "err" | "muted" | "blue"> = {
  queued: "muted",
  running: "blue",
  succeeded: "ok",
  failed: "err",
  cancelled: "muted",
};

const isQueueKind = (value: string | undefined): value is QueueKind => QUEUE_ORDER.includes(value as QueueKind);

// 결과/오류 열: 실패는 오류 메시지, 완료는 결과 요약.
export function jobOutcome(job: JobResponse): string {
  if (job.state === "failed") return job.error_message || job.error_code || "실패";
  if (job.state === "cancelled") return "취소됨";
  if (job.state !== "succeeded") return job.total ? `${job.completed}/${job.total}` : "";
  const r = job.result || {};
  const queue = resultSummary(r);
  if (queue) return queue;
  if (Array.isArray(r.documents)) return `문서 ${r.documents.length}개`;
  if (typeof r.row_count === "number") return `행 ${r.row_count}개`;
  if (r.download_url || r.build_key) return "산출물 생성";
  if (typeof r.matched === "number") return `일치 ${r.matched}건`;
  return "완료";
}

export default function Jobs() {
  const { route, go, reset } = useNavigation();
  const { notify } = useToast();
  const writeSeq = useWriteSeq();
  const status = useData<StatusResponse>("/status");
  const queues = useData<QueueSummary>("/queues");
  const jobsPath = withQuery("/jobs", { state: route.state, kind: route.kind });
  const jobs = usePage<JobResponse>(jobsPath);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [pending, setPending] = useState(0);
  const [tick, setTick] = useState(0);

  const counts = queues.data?.counts;
  // URL에 큐가 없으면 요약이 온 뒤 첫 번째로 비어 있지 않은 큐(없으면 매핑 검수)를 고른다 — 헛된 호출을 막는다.
  const selected: QueueKind | null = isQueueKind(route.queue)
    ? route.queue
    : counts
      ? QUEUE_ORDER.find((k) => (counts[k] ?? 0) > 0) || "review"
      : null;

  // 조용한 새로고침(로딩 표시 없이 교체). 첫 페이지일 때만 작업 목록을 다시 받는다.
  const { setData: setQueues } = queues;
  const { setData: setJobs, number: pageNumber } = jobs;
  const refreshAll = useCallback(async () => {
    const [q, j] = await Promise.all([
      api<QueueSummary>("/queues", undefined, { fresh: true }).catch(() => null),
      pageNumber === 1
        ? api<Page<JobResponse>>(withQuery(jobsPath, { limit: PAGE_LIMIT }), undefined, { fresh: true }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (q) setQueues(q);
    if (j) setJobs(j);
  }, [jobsPath, pageNumber, setQueues, setJobs]);
  useEffect(() => {
    if (!tick) return;
    void refreshAll();
  }, [tick, refreshAll]);

  const polling = pending > 0 || jobs.items.some(isJobActive) || (jobs.data === null && (status.data?.counts.jobs_running ?? 0) > 0);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(timer);
  }, [polling]);
  // 다른 화면 요소(검수 오버레이 등)에서 쓰기가 일어나면 한 번 새로 받는다(진입 시점의 값은 무시).
  const seenWrite = useRef(writeSeq);
  useEffect(() => {
    if (writeSeq === seenWrite.current) return;
    seenWrite.current = writeSeq;
    setTick((t) => t + 1);
  }, [writeSeq]);

  const onCountDelta = useCallback(
    (kind: QueueKind, delta: number) => {
      setPending((n) => (delta < 0 ? n + 1 : Math.max(0, n - 1)));
      setQueues((p) => (p ? { ...p, counts: { ...p.counts, [kind]: Math.max(0, (p.counts[kind] ?? 0) + delta) } } : p));
    },
    [setQueues],
  );
  const onSettled = useCallback(() => {
    setPending((n) => Math.max(0, n - 1));
    setTick((t) => t + 1);
  }, []);

  async function cancel(job: JobResponse) {
    const previous = job.state;
    jobs.setData((p) => (p ? { ...p, items: p.items.map((j) => (j.job_id === job.job_id ? { ...j, state: "cancelled" } : j)) } : p));
    try {
      await api("/jobs/" + encodeURIComponent(job.job_id) + "/cancel", {});
      notify(`${jobLabel(job)} · 취소를 요청했습니다.`);
    } catch (failure) {
      jobs.setData((p) => (p ? { ...p, items: p.items.map((j) => (j.job_id === job.job_id ? { ...j, state: previous } : j)) } : p));
      notify(`${jobLabel(job)} 취소 실패: ${errorMessage(failure)}`);
    }
    setTick((t) => t + 1);
  }

  function goToTarget(job: JobResponse) {
    const id = job.target_id || "";
    if (job.target_kind === "document") reset({ screen: "documents", document: id });
    else if (job.target_kind === "profile") reset({ screen: "profiles", profile: id });
    else if (job.target_kind === "application") go(reviewRoute({ application_id: id }));
    else if (job.target_kind === "build") reset({ screen: "build" });
  }
  const canGo = (job: JobResponse) =>
    (job.target_kind === "build" || !!job.target_id) && ["document", "profile", "application", "build"].includes(job.target_kind || "");

  return (
    <>
      <div inert={dialog ? true : undefined}>
        <Heading title="작업 내역" description="정상 처리되지 않은 것을 원인별로 묶어 처리하고, 비동기 작업의 결과를 확인합니다." />
        <RenderServerLine status={status.data} />
        <div className="v3-summary" role="group" aria-label="검수 큐 요약">
          {QUEUE_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              className={"v3-summary-card" + (selected === kind ? " selected" : "")}
              aria-pressed={selected === kind}
              onClick={() => go({ queue: kind })}
            >
              <strong>{counts ? counts[kind] ?? 0 : "–"}</strong>
              <span>{QUEUE_LABELS[kind]}</span>
            </button>
          ))}
        </div>
        {(queues.error || queues.loading) && <State resource={queues} />}
        {selected && <QueuePanel key={selected} kind={selected} tick={tick} onCountDelta={onCountDelta} onDialog={setDialog} onSettled={onSettled} />}
        <section className="v3-card" aria-label="작업 목록 카드">
          <div className="v3-card-head">
            <h2>작업 목록</h2>
            <div className="v3-inline">
              <label>
                종류
                <select value={route.kind || ""} onChange={(e) => go({ kind: e.target.value })}>
                  <option value="">전체</option>
                  {Object.entries(JOB_KIND_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                상태
                <select value={route.state || ""} onChange={(e) => go({ state: e.target.value })}>
                  <option value="">전체</option>
                  {Object.entries(JOB_STATE_LABELS).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <State resource={jobs} empty="아직 작업이 없습니다." />
          {jobs.items.length > 0 && (
            <div className="v3-table-wrap">
              <table className="v3-table" aria-label="작업 목록">
                <thead>
                  <tr>
                    <th scope="col">종류</th>
                    <th scope="col">대상</th>
                    <th scope="col">상태</th>
                    <th scope="col">시작</th>
                    <th scope="col">종료</th>
                    <th scope="col">결과/오류</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.items.map((job) => (
                    <tr key={job.job_id} className={job.state === "failed" ? "v3-job-failed" : undefined}>
                      <td>{JOB_KIND_LABELS[job.kind] || job.kind}</td>
                      <td>{jobLabel(job)}</td>
                      <td>
                        <Chip kind={STATE_CLASS[job.state] || "muted"}>
                          {JOB_STATE_LABELS[job.state] || job.state}
                          {isJobActive(job) && job.total ? ` ${job.completed}/${job.total}` : ""}
                        </Chip>
                      </td>
                      <td title={job.started_at || undefined}>{formatDateTime(job.started_at)}</td>
                      <td title={job.finished_at || undefined}>{formatDateTime(job.finished_at)}</td>
                      <td className="v3-wrap">
                        <div className="v3-inline">
                          <span className={job.state === "failed" ? "v3-error-text" : undefined}>{jobOutcome(job)}</span>
                          {job.state === "failed" && canGo(job) && (
                            <button type="button" className="small secondary" onClick={() => goToTarget(job)}>
                              이동
                            </button>
                          )}
                          {isJobActive(job) && (
                            <button type="button" className="small danger" onClick={() => void cancel(job)}>
                              취소
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={jobs} />
        </section>
      </div>
      {dialog && <QueueActionDialog request={dialog} onClose={() => setDialog(null)} />}
    </>
  );
}

// 렌더 서버 상태 한 줄(GET /status → render{mode, url, queue_depth, rendering}).
function RenderServerLine({ status }: { status: StatusResponse | null }) {
  if (!status) return null;
  const render = status.render;
  const mode = render.mode === "http" ? "외부 서버(HTTP)" + (render.url ? ` · ${render.url}` : "") : "내장(in-process)";
  return (
    <p className="v3-note v3-render-status" role="status" aria-label="렌더 서버 상태">
      <span>렌더 서버</span> {mode} · 대기 {render.queue_depth}건 · 렌더링 중 {render.rendering}건
      {status.counts.jobs_running > 0 ? ` · 진행 중 작업 ${status.counts.jobs_running}` : ""}
    </p>
  );
}
