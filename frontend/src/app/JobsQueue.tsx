// 작업 내역 화면의 검수 큐 패널(§4.11·§7 Jobs): 묶음 행 `대상 · 원인 · 영향 · 처리`, 펼치면 멤버, 묶음 버튼은
// POST /queues/{kind}/groups/{group_key}/actions?wait=10 + 낙관적 갱신(실패 시 되돌림). group_key(서명 sha256 등)는 화면에 쓰지 않는다.
import { useEffect, useState } from "react";
import {
  Pager,
  State,
  api,
  errorMessage,
  isJobActive,
  reviewRoute,
  snapshotLabel,
  useData,
  useNavigation,
  usePage,
  useToast,
  withQuery,
} from "./client";
import type { JobResponse, Page, ProfileRow, QueueAction, QueueActionResult, QueueGroup, QueueKind, QueueMemberRow } from "./types";
import { QUEUE_LABELS } from "./types";
import { Chip, Modal, StatusChip } from "./ui";

export const QUEUE_ORDER: QueueKind[] = ["unmatched", "review", "failed", "changed", "conflict"];
export const ACTION_LABELS: Record<QueueAction, string> = {
  open_review: "검수 열기",
  create_profile: "프로파일 만들기",
  assign_profile: "프로파일 지정",
  approve_all: "전체 승인",
  reparse: "재파싱",
};
// 승인 가능 여부를 서버가 actions[]로 알리는 큐: 버튼은 항상 보이되 허용되지 않으면 비활성.
const APPROVE_KINDS: QueueKind[] = ["review", "changed"];

export type ActionBody = { action: QueueAction; profile_id?: string; extract?: boolean; mode?: "rematch" | "fill" };
export type DialogRequest = {
  group: QueueGroup;
  action: "assign_profile" | "reparse";
  submit: (body: ActionBody) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// POST ?wait=10 뒤에도 끝나지 않은 작업은 1초 간격으로 GET /jobs/{id}. 최종 JobResponse를 돌려준다.
async function runQueueAction(kind: QueueKind, groupKey: string, body: ActionBody): Promise<JobResponse> {
  let job = await api<JobResponse>(
    withQuery(`/queues/${kind}/groups/${encodeURIComponent(groupKey)}/actions`, { wait: 10 }),
    body,
  );
  while (isJobActive(job)) {
    await sleep(1000);
    job = await api<JobResponse>("/jobs/" + encodeURIComponent(job.job_id), undefined, { fresh: true });
  }
  return job;
}

export function resultSummary(result: Record<string, unknown> | null | undefined): string {
  const r = (result || {}) as Partial<QueueActionResult> & { skipped_count?: number };
  if (typeof r.queued !== "number") return "";
  // 목록(GET /jobs)의 축약 결과는 배열 대신 `<key>_count`만 싣는다(§6).
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : typeof r.skipped_count === "number" ? r.skipped_count : 0;
  return `처리 ${r.queued}건` + (skipped ? ` · 건너뜀 ${skipped}건` : "");
}

export default function QueuePanel({
  kind,
  tick,
  onCountDelta,
  onDialog,
  onSettled,
}: {
  kind: QueueKind;
  // 폴링 신호: 바뀔 때마다 목록을 조용히 새로 받는다(로딩 표시 없이).
  tick: number;
  onCountDelta: (kind: QueueKind, delta: number) => void;
  onDialog: (request: DialogRequest | null) => void;
  onSettled: () => void;
}) {
  const groups = usePage<QueueGroup>(`/queues/${kind}`);
  const { go, reset } = useNavigation();
  const { notify } = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const { setData, number } = groups;
  useEffect(() => {
    if (!tick || number !== 1) return;
    let cancelled = false;
    api<Page<QueueGroup>>(withQuery(`/queues/${kind}`, { limit: 50 }), undefined, { fresh: true })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick, kind, number, setData]);

  async function perform(group: QueueGroup, body: ActionBody) {
    const before = groups.data;
    const index = before?.items.findIndex((g) => g.group_key === group.group_key) ?? -1;
    // 낙관적 갱신: 행을 빼고 요약 수를 줄인다.
    groups.setData((p) => (p ? { ...p, items: p.items.filter((g) => g.group_key !== group.group_key) } : p));
    onCountDelta(kind, -group.count);
    const restore = () => {
      groups.setData((p) => {
        if (!p || p.items.some((g) => g.group_key === group.group_key)) return p;
        const items = [...p.items];
        items.splice(index < 0 ? items.length : index, 0, group);
        return { ...p, items };
      });
      onCountDelta(kind, group.count);
    };
    const head = `${QUEUE_LABELS[kind]} · ${group.label} · ${ACTION_LABELS[body.action]}`;
    try {
      const job = await runQueueAction(kind, group.group_key, body);
      if (job.state === "succeeded") {
        notify(`${head} · ${resultSummary(job.result) || "완료"}`);
      } else {
        restore();
        notify(`${head} 실패: ${job.error_message || job.state}`);
      }
    } catch (failure) {
      restore();
      notify(`${head} 실패: ${errorMessage(failure)}`);
    }
    onSettled();
  }

  function act(group: QueueGroup, action: QueueAction) {
    const rep = group.representative;
    if (action === "open_review") rep.application_id && go(reviewRoute({ application_id: rep.application_id }));
    else if (action === "create_profile") reset({ screen: "profiles", import: "1", snapshot: rep.snapshot_id });
    else if (action === "approve_all") void perform(group, { action, extract: true });
    else onDialog({ group, action, submit: (body) => void perform(group, body) });
  }

  return (
    <section className="app-card" aria-label={`${QUEUE_LABELS[kind]} 큐`}>
      <div className="app-card-head">
        <h2>{QUEUE_LABELS[kind]}</h2>
        <span className="app-muted app-small">같은 원인·같은 양식은 한 행으로 묶여 있습니다.</span>
      </div>
      <State resource={groups} empty={`${QUEUE_LABELS[kind]} 큐가 비어 있습니다.`} />
      {groups.items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label={`${QUEUE_LABELS[kind]} 묶음`}>
            <thead>
              <tr>
                <th scope="col">
                  <span className="app-visually-hidden">펼치기</span>
                </th>
                <th scope="col">대상</th>
                <th scope="col">원인</th>
                <th scope="col">영향</th>
                <th scope="col">처리</th>
              </tr>
            </thead>
            <tbody>
              {groups.items.map((group) => (
                <GroupRow
                  key={group.group_key}
                  kind={kind}
                  group={group}
                  expanded={open === group.group_key}
                  onToggle={() => setOpen(open === group.group_key ? null : group.group_key)}
                  onAction={(action) => act(group, action)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={groups} />
    </section>
  );
}

function GroupRow({
  kind,
  group,
  expanded,
  onToggle,
  onAction,
}: {
  kind: QueueKind;
  group: QueueGroup;
  expanded: boolean;
  onToggle: () => void;
  onAction: (action: QueueAction) => void;
}) {
  const actions: QueueAction[] = [...group.actions];
  if (APPROVE_KINDS.includes(kind) && !actions.includes("approve_all")) actions.push("approve_all");
  const impact = group.impact;
  const names = impact.rules?.length ? impact.rules : impact.fields?.length ? impact.fields : [];
  const namesLabel = impact.rules?.length ? "규칙" : "필드";
  return (
    <>
      <tr className={expanded ? "selected" : undefined}>
        <td>
          <button
            type="button"
            className="small link"
            aria-expanded={expanded}
            aria-label={`${group.label} 멤버 ${expanded ? "접기" : "펼치기"}`}
            onClick={onToggle}
          >
            {expanded ? "▾" : "▸"}
          </button>
        </td>
        <td>
          <strong>{group.label}</strong>
          <div className="app-small app-muted">
            문서 {group.count}개 · 대표 {group.representative.document_name}
          </div>
        </td>
        <td className="app-wrap">{group.cause}</td>
        <td>
          <div>문서 {impact.documents}개</div>
          {names.length > 0 && (
            <div className="app-chips">
              <span className="app-small app-muted">
                {namesLabel} {names.length}개
              </span>
              {names.slice(0, 5).map((name) => (
                <Chip key={name} kind="muted">
                  {name}
                </Chip>
              ))}
              {names.length > 5 && <span className="app-small app-muted">+{names.length - 5}</span>}
            </div>
          )}
        </td>
        <td>
          <div className="app-inline">
            {actions.map((action) => {
              const allowed = group.actions.includes(action);
              const needsApplication = action === "open_review" && !group.representative.application_id;
              return (
                <button
                  key={action}
                  type="button"
                  className={"small" + (action === "open_review" || action === "create_profile" ? " secondary" : " primary")}
                  disabled={!allowed || needsApplication}
                  title={!allowed ? "동일 구조 문서만 일괄 승인할 수 있습니다." : needsApplication ? "검수할 적용 결과가 없습니다." : undefined}
                  onClick={() => onAction(action)}
                >
                  {ACTION_LABELS[action]}
                </button>
              );
            })}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="app-queue-members">
          <td />
          <td colSpan={4}>
            <MemberRows kind={kind} group={group} />
          </td>
        </tr>
      )}
    </>
  );
}

// 멤버는 펼칠 때만 GET /queues/{kind}/groups/{group_key}/members.
function MemberRows({ kind, group }: { kind: QueueKind; group: QueueGroup }) {
  const members = usePage<QueueMemberRow>(`/queues/${kind}/groups/${encodeURIComponent(group.group_key)}/members`);
  const { go, reset } = useNavigation();
  return (
    <>
      <State resource={members} empty="멤버가 없습니다." />
      {members.items.length > 0 && (
        <table className="app-table" aria-label={`${group.label} 멤버`}>
          <thead>
            <tr>
              <th scope="col">문서명</th>
              <th scope="col">Snapshot</th>
              <th scope="col">상태</th>
              <th scope="col">원본 보기</th>
            </tr>
          </thead>
          <tbody>
            {members.items.map((m) => (
              <tr key={m.document_id}>
                <td>
                  <button type="button" className="link" onClick={() => reset({ screen: "documents", document: m.document_id })}>
                    {m.document_name}
                  </button>
                </td>
                <td>{m.snapshot ? snapshotLabel(m.snapshot) : "-"}</td>
                <td>
                  <StatusChip status={m.document_status || m.status || m.state || "-"} detail={m.detail?.error ?? m.error} />
                </td>
                <td>
                  <button
                    type="button"
                    className="small"
                    disabled={!m.application_id}
                    title={m.application_id ? undefined : "적용 결과가 없습니다."}
                    onClick={() => m.application_id && go(reviewRoute({ application_id: m.application_id }))}
                  >
                    원본 보기
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Pager page={members} />
    </>
  );
}

// 프로파일 지정(GET /profiles?status=approved) · 재파싱 방식 선택 대화상자.
export function QueueActionDialog({ request, onClose }: { request: DialogRequest; onClose: () => void }) {
  const { group, action } = request;
  const profiles = useData<Page<ProfileRow>>(action === "assign_profile" ? withQuery("/profiles", { status: "approved" }) : null);
  const [profileId, setProfileId] = useState("");
  const [mode, setMode] = useState<"rematch" | "fill">("rematch");
  const chosen = profileId || profiles.data?.items[0]?.profile_id || "";
  const label = ACTION_LABELS[action];
  function submit() {
    request.submit(action === "assign_profile" ? { action, profile_id: chosen } : { action, mode });
    onClose();
  }
  return (
    <Modal
      label="묶음 처리"
      title={label}
      className="narrow"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            취소
          </button>
          <button type="button" className="primary" disabled={action === "assign_profile" && !chosen} onClick={submit}>
            {label}
          </button>
        </>
      }
    >
      <p className="app-muted">
        {group.label} · 문서 {group.count}개에 한 번에 적용합니다.
      </p>
      {action === "assign_profile" ? (
        <>
          <State resource={profiles} empty="승인된 파싱 프로파일이 없습니다." />
          {!!profiles.data?.items.length && (
            <label>
              파싱 프로파일
              <select value={chosen} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.data.items.map((p) => (
                  <option key={p.profile_id} value={p.profile_id}>
                    {p.profile_name} v{p.current_rev}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      ) : (
        <label>
          재파싱 방식
          <select value={mode} onChange={(e) => setMode(e.target.value as "rematch" | "fill")}>
            <option value="rematch">다시 매칭 (rematch)</option>
            <option value="fill">빈 곳 채우기 (fill)</option>
          </select>
        </label>
      )}
    </Modal>
  );
}
