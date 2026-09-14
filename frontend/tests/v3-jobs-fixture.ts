// 작업 내역 화면 테스트 픽스처: 공용 v3Fixture 위에 검수 큐(GET /queues · /queues/{kind} · members · POST actions)와
// 작업 목록(target_kind별 실패 작업 · 진행 중 작업 · 취소)을 상태 있게 덧붙인다. 묶음 처리 POST는 그 묶음을 큐에서 빼고 요약 수를 줄인다.
import type { JobResponse, QueueGroup, QueueKind, QueueMemberRow } from "../src/v3/types";
import { errorBody, ids, job, page, reply, sha256, uuid, v3Fixture } from "./v3-fixture";
import type { Call } from "./v3-fixture";

export const DOC_NAMES = ["공정데이터_2024_01.xlsx", "공정데이터_2024_02.xlsx", "공정데이터_2024_03.xlsx", "구양식_2019_07.xlsx"];
export const GROUP_KEYS = {
  unmatched: sha256(3),
  reviewA: ids.profile,
  reviewB: ids.profile2,
  failed: "SELECTOR_NOT_FOUND",
  changed: "incompatible",
};
export const REVIEW_APPLICATION = uuid(11, "cccc");
export const FAILED_APPLICATION = uuid(16, "cccc");
export const RUNNING_JOB = uuid(6, "ffff");
export const FAILED_JOBS = {
  build: uuid(2, "ffff"),
  application: uuid(3, "ffff"),
  profile: uuid(4, "ffff"),
  document: uuid(7, "ffff"),
};

export function queueGroups(): Record<QueueKind, QueueGroup[]> {
  return {
    unmatched: [
      {
        group_key: GROUP_KEYS.unmatched,
        kind: "unmatched",
        cause: "맞는 파싱 프로파일이 없습니다 (새 구조 서명)",
        label: "신규 양식 후보 · 3문서",
        count: 3,
        impact: { documents: 3 },
        representative: { document_id: ids.document(4), document_name: DOC_NAMES[3], snapshot_id: uuid(14, "aaaa") },
        actions: ["create_profile", "assign_profile"],
      },
    ],
    review: [
      {
        group_key: GROUP_KEYS.reviewA,
        kind: "review",
        cause: "헤드 매핑 2건이 검수 대기 중입니다",
        label: "공정데이터_A양식 v2",
        count: 3,
        impact: { documents: 3, rules: ["temperature", "pressure"] },
        representative: { document_id: ids.document(2), document_name: DOC_NAMES[1], snapshot_id: uuid(11, "aaaa"), application_id: REVIEW_APPLICATION, profile_id: ids.profile },
        actions: ["open_review", "approve_all"],
      },
      {
        group_key: GROUP_KEYS.reviewB,
        kind: "review",
        cause: "구조가 달라 일괄 승인할 수 없습니다",
        label: "공정데이터_B양식 v1",
        count: 2,
        impact: { documents: 2, rules: ["pressure"] },
        representative: { document_id: ids.document(1), document_name: DOC_NAMES[0], snapshot_id: ids.snapshot, application_id: ids.application2, profile_id: ids.profile2 },
        actions: ["open_review"],
      },
    ],
    failed: [
      {
        group_key: GROUP_KEYS.failed,
        kind: "failed",
        cause: "선택자 'find 온도'가 시트 Sheet1에서 셀을 찾지 못했습니다.",
        label: "선택자 실패 · 공정데이터_A양식 v2",
        count: 2,
        impact: { documents: 2, rules: ["temperature"] },
        representative: { document_id: ids.document(6), document_name: "손상파일_2024.xlsx", snapshot_id: uuid(16, "aaaa"), application_id: FAILED_APPLICATION, profile_id: ids.profile },
        actions: ["open_review", "reparse"],
      },
    ],
    changed: [
      {
        group_key: GROUP_KEYS.changed,
        kind: "changed",
        cause: "새 Snapshot의 구조가 파싱 프로파일과 맞지 않습니다",
        label: "구조 변경 · 공정데이터_A양식 v2",
        count: 1,
        impact: { documents: 1, fields: ["temperature"] },
        representative: { document_id: ids.document(3), document_name: DOC_NAMES[2], snapshot_id: uuid(13, "aaaa"), application_id: uuid(13, "cccc"), profile_id: ids.profile },
        actions: ["open_review", "assign_profile"],
      },
    ],
    conflict: [],
  };
}

export function memberRows(): QueueMemberRow[] {
  return [
    { document_id: ids.document(2), document_name: DOC_NAMES[1], snapshot: { snapshot_id: uuid(11, "aaaa"), revision_no: 1, captured_at: "2026-09-14T07:00:00Z" }, status: "review", application_id: REVIEW_APPLICATION },
    { document_id: ids.document(3), document_name: DOC_NAMES[2], snapshot: { snapshot_id: uuid(12, "aaaa"), revision_no: 1, captured_at: "2026-09-13T07:00:00Z" }, status: "review", application_id: uuid(12, "cccc") },
    { document_id: ids.document(5), document_name: "공정데이터_2024_04.xlsx", snapshot: null, status: "not_extracted", application_id: null, error: "실행 기록이 없습니다." },
  ];
}

export function jobRows(): JobResponse[] {
  return [
    job(),
    job({ job_id: FAILED_JOBS.build, kind: "build", state: "failed", error_code: "INVALID_HEADER", error_message: "출력 Header가 비어 있습니다.", label: "빌드 · 문서 3개", target_kind: "build", target_id: "abcdef0123456789" }),
    job({ job_id: FAILED_JOBS.application, kind: "extract", state: "failed", error_code: "SELECTOR_NOT_FOUND", error_message: "선택자 'find 온도'가 셀을 찾지 못했습니다.", label: "손상파일_2024.xlsx · 추출", target_kind: "application", target_id: FAILED_APPLICATION }),
    job({ job_id: FAILED_JOBS.profile, kind: "reparse", state: "failed", error_code: "REPARSE_FAILED", error_message: "재파싱 중 2개 문서가 실패했습니다.", label: "공정데이터_A양식 v2 · 재파싱", target_kind: "profile", target_id: ids.profile }),
    job({ job_id: FAILED_JOBS.document, kind: "register", state: "failed", error_code: "DRM_READER_REQUIRED", error_message: "DRM Reader가 필요합니다.", label: "보안문서_2024.xlsx · 등록", target_kind: "document", target_id: ids.document(7) }),
    job({ job_id: uuid(5, "ffff"), kind: "queue_action", state: "succeeded", total: 4, completed: 4, result: { queued: 4, skipped: [] }, label: "전체 승인 · 공정데이터_A양식 v2", target_kind: "profile", target_id: ids.profile }),
  ];
}

export function runningJob(): JobResponse {
  return job({ job_id: RUNNING_JOB, kind: "reparse", state: "running", completed: 2, total: 5, finished_at: null, label: "공정데이터_B양식 v1 · 재파싱", target_kind: "profile", target_id: ids.profile2 });
}

export function jobsFixture(options: { running?: boolean; actionFails?: boolean } = {}) {
  const f = v3Fixture();
  const groups = queueGroups();
  const counts: Record<QueueKind, number> = { unmatched: 3, review: 5, failed: 2, changed: 1, conflict: 0 };
  const actions: { kind: QueueKind; groupKey: string; body: Record<string, any> }[] = [];
  const cancelled: string[] = [];
  if (options.running !== false) f.state.running = [runningJob()];

  f.overrides.set("GET /queues", () => ({ counts: { ...counts } }));
  for (const kind of Object.keys(groups) as QueueKind[]) {
    f.overrides.set(`GET /queues/${kind}`, () => page(groups[kind]));
    for (const group of groups[kind]) {
      const base = `/queues/${kind}/groups/${encodeURIComponent(group.group_key)}`;
      f.overrides.set(`GET ${base}/members`, () => page(memberRows().slice(0, group.count)));
      f.overrides.set(`POST ${base}/actions`, (call: Call) => {
        actions.push({ kind, groupKey: group.group_key, body: call.body || {} });
        if (options.actionFails) return reply(422, errorBody("ACTION_NOT_ALLOWED", "이 묶음에는 허용되지 않는 처리입니다."));
        groups[kind] = groups[kind].filter((g) => g.group_key !== group.group_key);
        counts[kind] = Math.max(0, counts[kind] - group.count);
        return job({
          job_id: uuid(90, "ffff"),
          kind: "queue_action",
          state: "succeeded",
          total: group.count,
          completed: group.count,
          label: `${call.body?.action} · ${group.label}`,
          result: { queued: group.count - 1, skipped: [{ document_id: group.representative.document_id, document_name: group.representative.document_name, reason: "이미 승인됨" }] },
        });
      });
    }
  }
  f.overrides.set("GET /jobs", (call: Call) => {
    const st = call.url.searchParams.get("state");
    const kind = call.url.searchParams.get("kind");
    if (st === "running") return page(f.state.running.filter((j) => j.state === "running"));
    let items = [...jobRows(), ...f.state.running];
    if (st) items = items.filter((j) => j.state === st);
    if (kind) items = items.filter((j) => j.kind === kind);
    return page(items);
  });
  f.overrides.set(`POST /jobs/${RUNNING_JOB}/cancel`, () => {
    cancelled.push(RUNNING_JOB);
    f.state.running = f.state.running.map((j) => (j.job_id === RUNNING_JOB ? { ...j, state: "cancelled" as const, finished_at: "2026-09-14T09:00:00Z" } : j));
    return f.state.running[0];
  });
  return { ...f, groups, counts, actions, cancelled };
}
