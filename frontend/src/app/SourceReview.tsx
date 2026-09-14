// Source Review 전체 화면 오버레이(§7, ui-development-spec §8): 원본 시트와 파싱 결과를 한 화면에서 검수한다.
// - 검수 모드 `?review=<application_id>&rule=&sheet=&range=`: 진입 호출 = GET /applications/{aid} 1회 + 렌더 창.
//   3열 = 좌(시트·프로파일·규칙) / 중앙 SheetViewer(review; overlay key/value/unit/context, 드래그 재지정 + 역할 선택)
//   / 우 MappingPanel(수정·승인·반려·접힌 상세). 규칙 클릭은 추가 호출 없음. 쓰기는 낙관적 갱신, 409 EDIT_CONFLICT → 다시 읽기.
// - 테스트 모드 `?test=<profile_id>|draft&snapshot=<sid>`: POST /profiles/{id}/test 또는 /profiles/test(초안은 profileDraft에서),
//   우측은 §4.7 groups[]·errors[], 행동은 닫기 · 다시 실행뿐.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { ApiError, State, api, errorMessage, profileLabel, schemaLabel, snapshotLabel, useData, useJob, useNavigation } from "./client";
import type { Area, ApplicationSummary, JobResponse, MappingRegion, MappingRevisionRow, MappingRow, MappingStatus, Page, ProfileDetail, RegionRef, SheetRow, TestGroup, TestResult } from "./types";
import { JOB_STATE_LABELS } from "./types";
import { formatRange } from "./sheetGeometry";
import SheetViewer from "./SheetViewer";
import type { Overlay } from "./SheetViewer";
import { Chip, EmptyState } from "./ui";
import { useProfileDraft } from "./profileDraft";
import MappingPanel from "./SourceReviewMapping";
import type { PanelMessage } from "./SourceReviewMapping";
import TestResultPanel from "./SourceReviewTest";
import {
  REGION_ROLES,
  compatibilityLabel,
  countApproved,
  focusFor,
  isJobResponse,
  isMappingRow,
  jobSummary,
  mappingStatusClass,
  mappingStatusLabel,
  mergeRegions,
  overlaysFor,
  regionsToRequest,
  replaceRole,
  roleLabel,
} from "./sourceReviewShared";
import type { RegionRole } from "./sourceReviewShared";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5];
const CLOSE_PATCH = { review: "", test: "", rule: "", range: "", snapshot: "" };

export default function SourceReview() {
  const { route } = useNavigation();
  if (route.test) return <TestReview key={route.test + "/" + (route.snapshot || "")} profileId={route.test} snapshotId={route.snapshot || ""} />;
  return <ApplicationReview key={route.review || ""} applicationId={route.review || ""} />;
}

// ---------------------------------------------------------------- 공용 틀(오버레이·컨텍스트 줄·Escape)

function ReviewFrame({ context, banner, children, onClose }: { context: ReactNode; banner?: ReactNode; children: ReactNode; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    // 뷰어의 드래그 취소(Escape)는 오버레이를 닫지 않는다.
    if (root.current?.querySelector(".app-overlay.drag")) return;
    e.stopPropagation();
    onClose();
  }
  return (
    <div className="app-overlay-screen" role="dialog" aria-modal="true" aria-label="Source Review" tabIndex={-1} ref={root} onKeyDown={onKeyDown}>
      <div className="app-context">
        <button type="button" onClick={onClose}>
          ← 돌아가기
        </button>
        {context}
      </div>
      {banner}
      {children}
    </div>
  );
}

function ZoomSelect({ value, onChange }: { value: number; onChange: (zoom: number) => void }) {
  return (
    <label className="app-inline app-small">
      확대
      <select aria-label="확대" value={String(value)} onChange={(e) => onChange(Number(e.target.value))}>
        {ZOOM_LEVELS.map((level) => (
          <option key={level} value={String(level)}>
            {Math.round(level * 100)}%
          </option>
        ))}
      </select>
    </label>
  );
}

function SheetList({ sheets, currentId, rolesOf, onSelect }: { sheets: SheetRow[]; currentId: string | undefined; rolesOf: (sheet: SheetRow) => string[]; onSelect: (sheet: SheetRow) => void }) {
  return (
    <>
      <h3>시트</h3>
      <div className="app-list" role="group" aria-label="시트 목록">
        {sheets.length === 0 && <p className="app-muted app-small">시트가 없습니다.</p>}
        {sheets.map((sheet) => {
          const roles = rolesOf(sheet);
          return (
            <button key={sheet.sheet_id} type="button" className={"app-list-item" + (sheet.sheet_id === currentId ? " selected" : "")} aria-current={sheet.sheet_id === currentId ? "true" : undefined} onClick={() => onSelect(sheet)}>
              <span>
                <strong>{sheet.sheet_name}</strong>
                {roles.length ? <small>역할: {roles.join(", ")}</small> : <small className="app-muted">역할 없음</small>}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function RolePicker({ value, onChange }: { value: RegionRole; onChange: (role: RegionRole) => void }) {
  return (
    <span className="app-inline app-small">
      드래그 역할
      <span className="app-segment" role="group" aria-label="선택 역할">
        {REGION_ROLES.map((role) => (
          <button key={role} type="button" aria-pressed={value === role} onClick={() => onChange(role)}>
            {roleLabel(role)}
          </button>
        ))}
      </span>
    </span>
  );
}

const pageItems = <T,>(data: Page<T> | T[] | null): T[] => (Array.isArray(data) ? data : data?.items ?? []);

// §4.5 approve-all 응답은 `{application_id, approved, skipped[], extraction: JobResponse|null}`이다(픽스처·구형 응답은 작업 응답 자체).
// 배너·추적에 쓰는 작업 응답 하나로 맞춘다: 추출 작업이 있으면 그 작업(+승인 수), 없으면 승인 결과만 담은 완료 응답.
type ApproveAllResult = { application_id: string; approved: number; skipped: { rule_key: string; reason: string }[]; extraction: JobResponse | null };
export function approveAllJob(response: JobResponse | ApproveAllResult): JobResponse {
  if (isJobResponse(response)) return response;
  const skipped = response.skipped?.length ?? 0;
  const summary = { approved: response.approved, ...(skipped ? { skipped } : {}) };
  if (response.extraction && isJobResponse(response.extraction))
    return { ...response.extraction, result: { ...(response.extraction.result || {}), ...summary } };
  const stamp = new Date().toISOString();
  return {
    job_id: "",
    kind: "approve_all",
    state: skipped ? "failed" : "succeeded",
    completed: response.approved,
    total: response.approved + skipped,
    result: summary,
    error_code: skipped ? "FIELD_REQUIRED" : null,
    error_message: skipped ? `${skipped}개 규칙은 필드가 없어 승인하지 못했습니다` : null,
    target_kind: "application",
    target_id: response.application_id,
    label: null,
    created_at: stamp,
    started_at: stamp,
    finished_at: stamp,
  };
}

// ---------------------------------------------------------------- 검수 모드

function ApplicationReview({ applicationId }: { applicationId: string }) {
  const { route, go } = useNavigation();
  const application = useData<ApplicationSummary>(applicationId ? "/applications/" + encodeURIComponent(applicationId) : null);
  // 다시 읽는 동안에도 마지막 데이터로 화면을 유지한다(패널 단위 로딩).
  const lastApp = useRef<ApplicationSummary | null>(null);
  if (application.data) lastApp.current = application.data;
  const app = application.data ?? lastApp.current;

  const [zoom, setZoom] = useState(1);
  const [selectionRole, setSelectionRole] = useState<RegionRole>("value");
  const [pending, setPending] = useState<Record<string, MappingRegion[]>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<PanelMessage>(null);
  const [approveAllResult, setApproveAllResult] = useState<JobResponse | null>(null);
  const approveAll = useJob();
  const extraction = useJob();

  const sheets = app?.sheets ?? [];
  const mappings = app?.mappings ?? [];
  const mapping = mappings.find((m) => m.rule_key === route.rule) || mappings[0] || null;
  const pendingRegions = mapping ? pending[mapping.mapping_id] || [] : [];
  const regions = useMemo(() => (mapping ? mergeRegions(mapping.regions, pendingRegions) : []), [mapping, pendingRegions]);
  const sheet =
    sheets.find((s) => s.sheet_id === route.sheet) ||
    sheets.find((s) => regions.some((r) => r.sheet_id === s.sheet_id)) ||
    sheets[0];
  const overlays = useMemo<Overlay[]>(() => overlaysFor(regions, sheet?.sheet_id), [regions, sheet?.sheet_id]);
  const focus = useMemo<Area | null>(() => focusFor(route.range, regions, sheet?.sheet_id), [route.range, regions, sheet?.sheet_id]);
  const proposedCount = mappings.filter((m) => m.status === "proposed").length;

  const close = useCallback(() => go(CLOSE_PATCH), [go]);
  const showRegion = (region: RegionRef) => go({ sheet: region.sheet_id, range: region.range });

  // 추출 작업(승인 응답이 진행 중 작업이면 폴링)이 끝나면 값을 다시 읽는다.
  const extractionJob = extraction.job;
  useEffect(() => {
    if (extractionJob && (extractionJob.state === "succeeded" || extractionJob.state === "failed" || extractionJob.state === "cancelled")) {
      setMessage({ kind: extractionJob.state === "succeeded" ? "info" : "error", text: "추출 " + jobSummary(extractionJob) });
      // 모두 승인에서 넘긴 추출 작업이면 배너도 최종 상태로 바꾼다(승인 수는 유지).
      setApproveAllResult((current) =>
        current && current.job_id === extractionJob.job_id ? { ...extractionJob, result: { ...(current.result || {}), ...(extractionJob.result || {}) } } : current,
      );
      application.reload();
    }
  }, [extractionJob?.state, extractionJob?.job_id]);

  function patchMapping(target: string, patch: Partial<MappingRow> | ((m: MappingRow) => Partial<MappingRow>)) {
    application.setData((current) => {
      if (!current) return current;
      const next = current.mappings.map((m) => (m.mapping_id === target ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m));
      return { ...current, mappings: next, heads_approved: countApproved(next), heads_total: next.length };
    });
  }

  // 낙관적 갱신 → POST → 실패면 되돌린다. 409 EDIT_CONFLICT는 최신 상태를 다시 읽고 알린다.
  async function write(target: MappingRow, path: string, body: Record<string, unknown>, optimistic: (m: MappingRow) => Partial<MappingRow>, doneText: string): Promise<boolean> {
    const previous = application.data;
    patchMapping(target.mapping_id, optimistic);
    setBusy(true);
    setMessage(null);
    try {
      const result = await api<unknown>(path, body);
      if (isMappingRow(result)) {
        // §4.5 revise 응답 = 매핑 행 + `extraction`(헤드가 전부 approved면 같은 요청에서 큐에 넣은 추출 작업, 아니면 null).
        const { extraction: extractionJob, ...row } = result as MappingRow & { extraction?: unknown };
        patchMapping(target.mapping_id, row);
        if (isJobResponse(extractionJob)) {
          if (extractionJob.state === "queued" || extractionJob.state === "running") {
            extraction.track(extractionJob);
            setMessage({ kind: "info", text: doneText + " · 추출 진행 중…" });
            return true;
          }
          setMessage({ kind: extractionJob.state === "succeeded" ? "info" : "error", text: doneText + " · 추출 " + jobSummary(extractionJob) });
          application.reload();
          return true;
        }
      } else if (isJobResponse(result)) {
        if (result.state === "queued" || result.state === "running") {
          extraction.track(result);
          setMessage({ kind: "info", text: doneText + " · 추출 진행 중…" });
          return true;
        }
        setMessage({ kind: result.state === "succeeded" ? "info" : "error", text: doneText + " · 추출 " + jobSummary(result) });
        application.reload();
        return true;
      }
      setMessage({ kind: "info", text: doneText });
      application.reload();
      return true;
    } catch (failure) {
      application.setData(previous);
      if (failure instanceof ApiError && (failure.code === "EDIT_CONFLICT" || failure.status === 409)) {
        setMessage({ kind: "error", text: "다른 곳에서 먼저 수정되어 최신 상태를 다시 불러왔습니다. 확인한 뒤 다시 시도하세요." });
        application.reload();
      } else setMessage({ kind: "error", text: errorMessage(failure) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(status: MappingStatus, extra?: { field_key?: string; reason?: string }) {
    if (!mapping) return false;
    const next = pendingRegions.length ? mergeRegions(mapping.regions, pendingRegions) : null;
    const body: Record<string, unknown> = {
      expected_seq: mapping.edit_seq,
      status,
      ...(extra?.field_key ? { field_key: extra.field_key } : {}),
      ...(next ? { regions: regionsToRequest(next) } : {}),
      ...(extra?.reason ? { reason: extra.reason } : {}),
      extract: true,
    };
    const ok = await write(
      mapping,
      "/mappings/" + encodeURIComponent(mapping.mapping_id) + "/revisions",
      body,
      (m) => ({
        status,
        regions: next || m.regions,
        field: extra?.field_key && extra.field_key !== m.field?.key ? { key: extra.field_key, name: extra.field_key } : m.field,
        revision_no: m.revision_no + 1,
        edit_seq: m.edit_seq + 1,
      }),
      status === "approved" ? "승인됨" : status === "rejected" ? "반려됨" : "저장됨",
    );
    if (ok) setPending((current) => ({ ...current, [mapping.mapping_id]: [] }));
    return ok;
  }

  async function rollback(revision: MappingRevisionRow) {
    if (!mapping) return false;
    return write(
      mapping,
      "/mappings/" + encodeURIComponent(mapping.mapping_id) + "/rollback",
      { expected_seq: mapping.edit_seq, target_revision_id: revision.mapping_revision_id },
      (m) => ({
        status: revision.status,
        field: revision.field,
        regions: revision.regions,
        observed_key: revision.observed_key,
        revision_no: m.revision_no + 1,
        edit_seq: m.edit_seq + 1,
      }),
      "복원됨",
    );
  }

  async function runApproveAll() {
    if (!app) return;
    const previous = application.data;
    application.setData((current) => {
      if (!current) return current;
      const next = current.mappings.map((m) => (m.status === "proposed" ? { ...m, status: "approved" as const } : m));
      return { ...current, mappings: next, heads_approved: countApproved(next) };
    });
    setApproveAllResult(null);
    const response = await approveAll.run("/applications/" + encodeURIComponent(app.application_id) + "/approve-all", { extract: true }, 20);
    if (!response) {
      application.setData(previous);
      return;
    }
    const job = approveAllJob(response);
    // wait 안에 추출이 끝나지 않았으면 이어서 폴링한다(끝나면 extractionJob 효과가 값을 다시 읽고 배너를 마무리한다).
    if (job.state === "queued" || job.state === "running") extraction.track(job);
    setApproveAllResult(job);
    application.reload();
  }

  function onSelect(area: Area) {
    if (!mapping || !sheet) return;
    const region: MappingRegion = { role: selectionRole, sheet_id: sheet.sheet_id, sheet_name: sheet.sheet_name, range: formatRange(area) };
    setPending((current) => ({ ...current, [mapping.mapping_id]: replaceRole(current[mapping.mapping_id] || [], region) }));
    setMessage(null);
  }

  const context = app ? (
    <>
      <strong>{app.document.document_name}</strong>
      <span className="app-muted">{snapshotLabel(app.snapshot)}</span>
      <span className="app-muted">/ {sheet?.sheet_name || "-"}</span>
      <span className="app-muted">/ {profileLabel(app.profile)}</span>
      <span className="app-muted">/ {schemaLabel(app.schema)}</span>
      <Chip kind={app.published ? "ok" : "warn"}>{app.published ? "발행됨" : "미발행"}</Chip>
      <Chip kind={app.heads_approved === app.heads_total ? "ok" : "warn"}>
        승인 {app.heads_approved}/{app.heads_total}
      </Chip>
      <Chip kind="muted" title="프로파일 일치도">
        {compatibilityLabel(app.compatibility)}
      </Chip>
      <span style={{ marginLeft: "auto" }} className="app-inline">
        <button type="button" className="primary" disabled={proposedCount === 0 || approveAll.busy || busy} onClick={() => void runApproveAll()}>
          모두 승인{proposedCount ? ` (${proposedCount})` : ""}
        </button>
      </span>
    </>
  ) : null;

  const banner = (
    <>
      {approveAll.busy && (
        <div className="app-note app-context" role="status">
          모두 승인 · 추출 진행 중… {approveAll.job && `(${JOB_STATE_LABELS[approveAll.job.state]})`}
        </div>
      )}
      {approveAll.error && (
        <div className="app-error app-context" role="alert">
          <span>{approveAll.error}</span>
        </div>
      )}
      {approveAllResult && !approveAll.busy && (
        <div className={(approveAllResult.state === "succeeded" ? "app-note" : "app-error") + " app-context"} role="status" data-testid="approve-all-result">
          <span>모두 승인 · 추출 {jobSummary(approveAllResult)}</span>
          <button type="button" className="link small" onClick={() => setApproveAllResult(null)}>
            닫기
          </button>
        </div>
      )}
    </>
  );

  return (
    <ReviewFrame context={context} banner={banner} onClose={close}>
      {!app && <State resource={application} />}
      {app && (
        <div className="app-split wide-right">
          <section className="app-card tight app-side-list" aria-label="시트와 파싱 규칙">
            <SheetList sheets={sheets} currentId={sheet?.sheet_id} rolesOf={(s) => s.roles || []} onSelect={(s) => go({ sheet: s.sheet_id, range: "" })} />
            <h3 style={{ marginTop: 12 }}>파싱 프로파일</h3>
            <p className="app-small">
              <strong>{profileLabel(app.profile)}</strong>
              <br />
              <span className="app-muted">{schemaLabel(app.schema)}</span>
            </p>
            <h3 style={{ marginTop: 12 }}>파싱 규칙</h3>
            <div className="app-list" role="group" aria-label="파싱 규칙 목록">
              {mappings.length === 0 && <p className="app-muted app-small">규칙이 없습니다.</p>}
              {mappings.map((m) => (
                <button key={m.mapping_id} type="button" className={"app-list-item" + (m.mapping_id === mapping?.mapping_id ? " selected" : "")} aria-current={m.mapping_id === mapping?.mapping_id ? "true" : undefined} onClick={() => go({ rule: m.rule_key, range: "" })}>
                  <span>
                    <strong>{m.rule_name}</strong>
                    <small>{m.field?.name || "필드 미지정"}</small>
                  </span>
                  <Chip kind={mappingStatusClass(m.status)}>{mappingStatusLabel(m.status)}</Chip>
                </button>
              ))}
            </div>
          </section>
          {sheet ? (
            <SheetViewer
              key={sheet.sheet_id}
              snapshotId={app.snapshot.snapshot_id}
              sheetId={sheet.sheet_id}
              sheetName={sheet.sheet_name}
              mode="review"
              zoom={zoom}
              overlays={overlays}
              focus={focus}
              selectionRole={selectionRole}
              onSelect={onSelect}
              height="calc(100vh - 150px)"
              initialRange={route.range}
              toolbarExtra={
                <>
                  <RolePicker value={selectionRole} onChange={setSelectionRole} />
                  <ZoomSelect value={zoom} onChange={setZoom} />
                </>
              }
            />
          ) : (
            <EmptyState className="app-card">시트가 없습니다.</EmptyState>
          )}
          <section className="app-card tight app-side-list" aria-label="매핑 상세">
            {mapping ? (
              <MappingPanel
                key={mapping.mapping_id}
                mapping={mapping}
                schemaKey={app.schema.schema_key}
                pending={pendingRegions}
                onRemovePending={(role) => setPending((current) => ({ ...current, [mapping.mapping_id]: (current[mapping.mapping_id] || []).filter((r) => r.role !== role) }))}
                busy={busy}
                message={message}
                onSubmit={submit}
                onRollback={rollback}
                onShowRegion={showRegion}
              />
            ) : (
              <EmptyState>파싱 규칙이 없습니다.</EmptyState>
            )}
          </section>
        </div>
      )}
    </ReviewFrame>
  );
}

// ---------------------------------------------------------------- 테스트 모드(§4.7)

type TestState = { loading: boolean; result: TestResult | null; error: string };

// §4.7 결과의 원본 위치는 서비스가 `regions: {role: [{sheet_name, range}]}` · `values[].sheet_name/range` · `bindings: {role: [sheet_name]}`
// (sheet_id 없음)로 주고, 검수 모드 매핑 행은 `regions[{role, sheet_id, sheet_name, range}]`로 준다. 두 모양을 모두 받아
// 시트 목록(snapshot의 sheets)으로 sheet_id를 채운 배열 모양으로 맞춘다 — overlay·초점·시트 역할 표시는 sheet_id로 동작한다.
export function normalizeTestResult(result: TestResult, sheets: SheetRow[]): TestResult {
  const byName = new Map(sheets.map((s) => [s.sheet_name, s.sheet_id] as const));
  const byId = new Set(sheets.map((s) => s.sheet_id));
  const ref = (region: Partial<RegionRef> & { sheet?: string }): RegionRef => {
    const sheetName = region.sheet_name ?? region.sheet ?? "";
    const sheetId = region.sheet_id && byId.has(region.sheet_id) ? region.sheet_id : byName.get(sheetName) ?? region.sheet_id ?? "";
    return { sheet_id: sheetId, sheet_name: sheetName || sheets.find((s) => s.sheet_id === sheetId)?.sheet_name || "", range: region.range || "" };
  };
  const groups = (result.groups || []).map((group) => {
    const raw = group.regions as unknown;
    const regions: TestGroup["regions"] = Array.isArray(raw)
      ? raw.map((r) => ({ ...ref(r), role: r.role }))
      : Object.entries((raw || {}) as Record<string, Partial<RegionRef>[]>).flatMap(([role, parts]) => (parts || []).map((r) => ({ ...ref(r), role })));
    const values = (group.values || []).map((value) => {
      const source = value.region || ((value as { sheet_name?: string; range?: string }).range ? (value as { sheet_name?: string; range?: string }) : undefined);
      return source ? { ...value, region: ref(source) } : value;
    });
    return { ...group, regions, values };
  });
  const bindings: Record<string, string[]> = {};
  for (const [role, names] of Object.entries(result.bindings || {}))
    bindings[role] = (Array.isArray(names) ? names : [names]).map((name) => (byId.has(name) ? name : byName.get(name) ?? name));
  return { ...result, groups, bindings };
}

function TestReview({ profileId, snapshotId }: { profileId: string; snapshotId: string }) {
  const { route, go } = useNavigation();
  const isDraft = profileId === "draft";
  const draft = useProfileDraft();
  const profile = useData<ProfileDetail>(!isDraft && profileId ? "/profiles/" + encodeURIComponent(profileId) : null);
  const sheetsResource = useData<Page<SheetRow> | SheetRow[]>(snapshotId ? "/snapshots/" + encodeURIComponent(snapshotId) + "/sheets" : null);
  const sheets = useMemo(() => pageItems(sheetsResource.data), [sheetsResource.data]);
  const [zoom, setZoom] = useState(1);
  const [run, setRun] = useState(0);
  const [test, setTest] = useState<TestState>({ loading: false, result: null, error: "" });
  const missingDraft = isDraft && !draft;

  useEffect(() => {
    if (!snapshotId || missingDraft) return;
    let cancelled = false;
    setTest({ loading: true, result: null, error: "" });
    const path = isDraft ? "/profiles/test" : "/profiles/" + encodeURIComponent(profileId) + "/test";
    const body = isDraft ? { schema_key: draft!.schema_key, definition: draft!.definition, snapshot_id: snapshotId } : { snapshot_id: snapshotId };
    api<TestResult | JobResponse>(path, body)
      .then((response) => {
        if (cancelled) return;
        const result = isJobResponse(response) ? ((response.result as unknown as TestResult | null) ?? null) : response;
        if (!result || !Array.isArray(result.groups)) setTest({ loading: false, result: null, error: isJobResponse(response) && response.error_message ? response.error_message : "테스트 결과를 받지 못했습니다." });
        else setTest({ loading: false, result: { ...result, errors: result.errors || [] }, error: "" });
      })
      .catch((failure: unknown) => {
        if (!cancelled) setTest({ loading: false, result: null, error: errorMessage(failure) });
      });
    return () => {
      cancelled = true;
    };
    // draft 객체는 저장소가 바뀔 때만 새 참조가 된다.
  }, [profileId, snapshotId, run, isDraft, draft, missingDraft]);

  const result = useMemo(() => (test.result ? normalizeTestResult(test.result, sheets) : null), [test.result, sheets]);
  const groups = result?.groups ?? [];
  const group = groups.find((g) => g.rule_key === route.rule) || groups[0] || null;
  const regions = useMemo(() => group?.regions ?? [], [group]);
  const sheet =
    sheets.find((s) => s.sheet_id === route.sheet) ||
    sheets.find((s) => regions.some((r) => r.sheet_id === s.sheet_id)) ||
    sheets[0];
  const overlays = useMemo<Overlay[]>(() => overlaysFor(regions, sheet?.sheet_id), [regions, sheet?.sheet_id]);
  const focus = useMemo<Area | null>(() => focusFor(route.range, regions, sheet?.sheet_id), [route.range, regions, sheet?.sheet_id]);
  const rolesOf = (s: SheetRow) =>
    Object.entries(result?.bindings || {})
      .filter(([, ids]) => Array.isArray(ids) && ids.includes(s.sheet_id))
      .map(([role]) => role);
  const close = useCallback(() => go(CLOSE_PATCH), [go]);
  const label = isDraft ? (draft?.profile_name ? `${draft.profile_name} (초안)` : "저장하지 않은 정의") : profile.data ? profileLabel(profile.data) : "파싱 프로파일";

  const context = (
    <>
      <strong>{label}</strong>
      <Chip kind="blue">테스트</Chip>
      {profile.data && <span className="app-muted">/ {schemaLabel(profile.data.schema)}</span>}
      {sheet && <span className="app-muted">/ {sheet.sheet_name}</span>}
      <span className="app-muted app-small">저장하지 않는 실행입니다</span>
      <span style={{ marginLeft: "auto" }} className="app-inline">
        <button type="button" className="secondary" disabled={test.loading || missingDraft} onClick={() => setRun((n) => n + 1)}>
          다시 실행
        </button>
        <button type="button" onClick={close}>
          닫기
        </button>
      </span>
    </>
  );

  return (
    <ReviewFrame context={context} onClose={close}>
      {missingDraft && (
        <div className="app-error app-context" role="alert">
          <span>편집 중인 정의가 없습니다. 파싱 프로파일 화면에서 정의를 다시 입력한 뒤 테스트하세요.</span>
        </div>
      )}
      {!snapshotId && (
        <div className="app-error app-context" role="alert">
          <span>테스트할 문서(snapshot)가 지정되지 않았습니다.</span>
        </div>
      )}
      <div className="app-split wide-right">
        <section className="app-card tight app-side-list" aria-label="시트와 파싱 규칙">
          <State resource={{ ...sheetsResource, data: sheets }} isEmpty={false} />
          <SheetList sheets={sheets} currentId={sheet?.sheet_id} rolesOf={rolesOf} onSelect={(s) => go({ sheet: s.sheet_id, range: "" })} />
          <h3 style={{ marginTop: 12 }}>파싱 프로파일</h3>
          <p className="app-small">
            <strong>{label}</strong>
          </p>
          <h3 style={{ marginTop: 12 }}>파싱 규칙</h3>
          <div className="app-list" role="group" aria-label="파싱 규칙 목록">
            {test.loading && (
              <p className="app-muted app-small" role="status">
                테스트 실행 중…
              </p>
            )}
            {!test.loading && groups.length === 0 && <p className="app-muted app-small">결과 규칙이 없습니다.</p>}
            {groups.map((g) => (
              <button key={g.rule_key} type="button" className={"app-list-item" + (g.rule_key === group?.rule_key ? " selected" : "")} aria-current={g.rule_key === group?.rule_key ? "true" : undefined} onClick={() => go({ rule: g.rule_key, range: "" })}>
                <span>
                  <strong>{g.field?.name || g.rule_key}</strong>
                  <small>{g.rule_key}</small>
                </span>
                <Chip kind={g.count > 0 ? "ok" : "muted"}>값 {g.count}</Chip>
              </button>
            ))}
          </div>
        </section>
        {sheet && snapshotId ? (
          <SheetViewer
            key={sheet.sheet_id}
            snapshotId={snapshotId}
            sheetId={sheet.sheet_id}
            sheetName={sheet.sheet_name}
            mode="review"
            zoom={zoom}
            overlays={overlays}
            focus={focus}
            height="calc(100vh - 150px)"
            initialRange={route.range}
            toolbarExtra={<ZoomSelect value={zoom} onChange={setZoom} />}
          />
        ) : (
          <EmptyState className="app-card">{sheetsResource.loading ? "시트를 불러오는 중…" : "시트가 없습니다."}</EmptyState>
        )}
        <section className="app-card tight app-side-list" aria-label="테스트 결과">
          {test.loading && (
            <p className="app-muted app-loading" role="status">
              테스트 실행 중…
            </p>
          )}
          {test.error && (
            <div className="app-error" role="alert">
              <span>{test.error}</span>
              <button type="button" className="small" onClick={() => setRun((n) => n + 1)}>
                다시 시도
              </button>
            </div>
          )}
          {result && <TestResultPanel result={result} group={group} onShowRegion={(region) => go({ sheet: region.sheet_id, range: region.range })} />}
        </section>
      </div>
    </ReviewFrame>
  );
}
