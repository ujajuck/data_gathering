// 문서 상세 드로어(§7, 모달: 형제 inert·focus trap·Esc). URL ?document=&tab=&sheet=.
// 헤더 = 문서명 + 상태 칩 + 현재 Snapshot(날짜 + 최신) · 관계 카드 `문서 → 프로파일 vN → 스키마 vN` · 접힌 `Snapshot 이력`
// (GET /documents/{id}/snapshots는 펼칠 때만) · 탭 `파일 보기(시트 목록 + SheetViewer readonly) · 추출 결과(GET /snapshots/{sid}/values,
// 규칙 필터, 행마다 원본 보기) · 적용 프로파일(GET /snapshots/{sid}/applications로 검수·발행 보강) · 연결 스키마`.
// 행동: 원본 보기 · 다시 파싱(적용 프로파일 행마다, 같은 프로파일로 POST /applications/{aid}/reparse?wait=10)
// · 다른 프로파일로 파싱(프로파일 선택 → POST /snapshots/{sid}/applications?wait=10) · 데이터 빌드에 추가.
// 진입 호출 ≤ 3: 문서 상세 + 시트 목록 + 렌더 창.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Pager,
  State,
  formatDateTime,
  isJobActive,
  profileLabel,
  regionLabel,
  reviewRoute,
  schemaLabel,
  snapshotLabel,
  useData,
  useJob,
  useNavigation,
  usePage,
  useToast,
  withQuery,
} from "./client";
import type { ApplicationReparse, ApplicationRow, DocumentDetail as DocumentDetailData, DocumentProfile, DocumentStatus, Page, ProfileRow, SheetRow, SnapshotRef, ValueRow } from "./types";
import { isReparseProcessed, isReparseSkipped, reparseReasonLabel } from "./types";
import { ApplicationStateChip, Chip, EmptyState, Modal, StatusChip, Tabs, ZoomControl, statusDetailText } from "./ui";
import { compatibilityLabel } from "./sourceReviewShared";
import SheetViewer from "./SheetViewer";

type Tab = "file" | "values" | "profiles" | "schemas";
const TABS: { id: Tab; label: string }[] = [
  { id: "file", label: "파일 보기" },
  { id: "values", label: "추출 결과" },
  { id: "profiles", label: "적용 프로파일" },
  { id: "schemas", label: "연결 스키마" },
];


const snapshotsPath = (sid: string) => `/snapshots/${encodeURIComponent(sid)}`;

export default function DocumentDetail({
  documentId,
  onAddToBuild,
  onDelete,
  inert = false,
}: {
  documentId: string;
  onAddToBuild: (id: string) => void;
  // 단건 삭제(§4.13)는 목록 화면이 확인 대화상자를 연다 — 드로어와 같은 대화상자를 쓴다.
  onDelete: (doc: DocumentDetailData) => void;
  // 삭제 확인 대화상자가 떠 있는 동안 드로어를 비활성으로 둔다(곧 지울 문서를 빌드에 담는 모순을 막는다).
  inert?: boolean;
}) {
  const { route, go, refresh, changed } = useNavigation();
  const document = useData<DocumentDetailData>("/documents/" + encodeURIComponent(documentId), refresh);
  const doc = document.data;
  const snapshotId = doc?.current_snapshot?.snapshot_id || "";
  const tab = (TABS.some((t) => t.id === route.tab) ? route.tab : "file") as Tab;
  const [pickerOpen, setPickerOpen] = useState(false);
  const close = () => go({ document: "", tab: "", sheet: "" });
  const firstApplication = doc?.profiles?.[0]?.application_id;
  return (
    <Modal
      label="문서 상세"
      inert={inert}
      onClose={close}
      head={
        doc ? (
          <div className="app-inline">
            <h2>{doc.document_name}</h2>
            <StatusChip status={doc.status as DocumentStatus} detail={statusDetailText(doc.status_detail, doc.last_error)} />
            {doc.current_snapshot ? (
              <span className="app-muted app-small app-inline">
                현재 Snapshot {snapshotLabel(doc.current_snapshot)} <Chip kind="blue">최신</Chip>
              </span>
            ) : (
              <span className="app-muted app-small">Snapshot 없음</span>
            )}
          </div>
        ) : (
          <h2>문서 상세</h2>
        )
      }
      actions={
        doc && (
          <>
            <button
              type="button"
              className="primary"
              disabled={!firstApplication}
              title={firstApplication ? undefined : "적용된 파싱 프로파일이 없어 원본 검수를 열 수 없습니다."}
              onClick={() => firstApplication && go(reviewRoute({ application_id: firstApplication }))}
            >
              원본 보기
            </button>
            <button
              type="button"
              disabled={!snapshotId || pickerOpen}
              title={snapshotId ? undefined : "현재 Snapshot이 없어 파싱할 수 없습니다."}
              onClick={() => setPickerOpen(true)}
            >
              다른 프로파일로 파싱
            </button>
            <button type="button" onClick={() => onAddToBuild(doc.document_id)}>
              데이터 빌드에 추가
            </button>
            <button type="button" className="danger" onClick={() => onDelete(doc)}>
              삭제
            </button>
          </>
        )
      }
    >
      {/* 지워진 문서를 가리키는 옛 작업 내역 행에서 들어오면 404다 — 무엇이 일어났는지 한 줄로 말한다(§7). */}
      {document.error?.status === 404 ? (
        <EmptyState>이 문서는 삭제되었습니다.</EmptyState>
      ) : (
        <State resource={document} />
      )}
      {doc && (
        <div className="app-stack">
          {doc.last_error && (
            <div className="app-error" role="alert">
              <span>최근 오류: {doc.last_error}</span>
            </div>
          )}
          <div className="app-relation" aria-label="문서 관계">
            <span>
              <small>문서</small>
              <strong>{doc.document_name}</strong>
            </span>
            <span className="arrow">→</span>
            <span>
              <small>파싱 프로파일</small>
              <strong>{doc.profiles.length ? doc.profiles.map(profileLabel).join(", ") : "없음"}</strong>
            </span>
            <span className="arrow">→</span>
            <span>
              <small>파싱 스키마</small>
              <strong>{doc.schemas.length ? doc.schemas.map((s) => schemaLabel(s)).join(", ") : "없음"}</strong>
            </span>
            <span className="app-toolbar-end app-muted app-small">
              {statusDetailText(doc.status_detail) ? statusDetailText(doc.status_detail) + " · " : ""}
              최근 처리 {doc.last_processed_at ? formatDateTime(doc.last_processed_at) : "-"}
            </span>
          </div>
          <SnapshotHistory documentId={doc.document_id} current={doc.current_snapshot} />
          {pickerOpen && (
            <ReparsePicker
              snapshotId={snapshotId}
              onClose={() => setPickerOpen(false)}
              onApplied={(applicationId) => {
                changed();
                if (applicationId) go({ tab: "profiles" });
              }}
            />
          )}
          <Tabs tabs={TABS} value={tab} onChange={(id) => go({ tab: id })} label="문서 상세 탭" />
          {tab === "file" && <FileTab snapshotId={snapshotId} />}
          {tab === "values" && <ValuesTab snapshotId={snapshotId} />}
          {tab === "profiles" && <ProfilesTab doc={doc} onReparse={() => setPickerOpen(true)} />}
          {tab === "schemas" && <SchemasTab doc={doc} />}
        </div>
      )}
    </Modal>
  );
}

// 접힌 Snapshot 이력: 펼칠 때만 GET /documents/{id}/snapshots. 행 `r{n} · 날짜` + 현재 항목에 `최신`.
function SnapshotHistory({ documentId, current }: { documentId: string; current: SnapshotRef | null }) {
  const [open, setOpen] = useState(false);
  const snapshots = useData<Page<SnapshotRef> | SnapshotRef[]>(open ? `/documents/${encodeURIComponent(documentId)}/snapshots` : null);
  const list = Array.isArray(snapshots.data) ? snapshots.data : snapshots.data?.items ?? [];
  return (
    <details className="app-details" open={open}>
      <summary
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >
        Snapshot 이력{current ? ` · 현재 r${current.revision_no}` : ""}
      </summary>
      {open && (
        <>
          <State resource={{ ...snapshots, data: list }} empty="Snapshot 이력이 없습니다." />
          {list.length > 0 && (
            <ul className="app-plain-list" aria-label="Snapshot 목록">
              {list.map((s) => (
                <li key={s.snapshot_id} className="app-inline">
                  <span>{snapshotLabel(s, { history: true })}</span>
                  {current?.snapshot_id === s.snapshot_id && <Chip kind="blue">최신</Chip>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </details>
  );
}

function FileTab({ snapshotId }: { snapshotId: string }) {
  const { route, go } = useNavigation();
  const sheets = useData<Page<SheetRow> | SheetRow[]>(snapshotId ? `${snapshotsPath(snapshotId)}/sheets` : null);
  const list = Array.isArray(sheets.data) ? sheets.data : sheets.data?.items ?? [];
  const current = list.find((s) => s.sheet_id === route.sheet) || list[0];
  const [zoom, setZoom] = useState(1);
  if (!snapshotId)
    return (
      <EmptyState>현재 Snapshot이 없어 파일을 보여줄 수 없습니다.</EmptyState>
    );
  return (
    <div className="app-split two">
      <section className="app-card tight">
        <h3>시트{list.length ? ` ${list.length}` : ""}</h3>
        <State resource={{ ...sheets, data: list }} empty="시트가 없습니다." />
        <div className="app-list app-side-list">
          {list.map((sheet) => (
            <button
              key={sheet.sheet_id}
              type="button"
              className={"app-list-item" + (current?.sheet_id === sheet.sheet_id ? " selected" : "")}
              aria-current={current?.sheet_id === sheet.sheet_id ? "true" : undefined}
              onClick={() => go({ sheet: sheet.sheet_id })}
            >
              <span>
                <strong>{sheet.sheet_name}</strong>
                <small>
                  {sheet.estimated_rows ? `${sheet.estimated_rows}행` : ""}
                  {sheet.estimated_rows && sheet.estimated_cols ? " · " : ""}
                  {sheet.estimated_cols ? `${sheet.estimated_cols}열` : ""}
                  {sheet.roles?.length ? ` · ${sheet.roles.join(", ")}` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
      </section>
      {current && (
        <SheetViewer
          snapshotId={snapshotId}
          sheetId={current.sheet_id}
          sheetName={current.sheet_name}
          mode="readonly"
          zoom={zoom}
          height={480}
          initialRange={route.range}
          toolbarExtra={<ZoomControl value={zoom} onChange={setZoom} />}
        />
      )}
    </div>
  );
}

// 추출 결과: keyset 표 `필드 · 파싱 규칙 · 값 · 단위 · 원본 위치 · 원본 보기`, 규칙 필터(?rule_key=).
function ValuesTab({ snapshotId }: { snapshotId: string }) {
  const { go, refresh } = useNavigation();
  const [rule, setRule] = useState("");
  const [rules, setRules] = useState<Map<string, string>>(new Map());
  // refresh: 같은 드로어에서 다시 파싱이 끝나면 값도 다시 읽는다.
  const values = usePage<ValueRow>(snapshotId ? withQuery(`${snapshotsPath(snapshotId)}/values`, { rule_key: rule }) : null, refresh);
  const items = values.items;
  useEffect(() => {
    if (!items.length) return;
    setRules((map) => {
      let next = map;
      for (const v of items)
        if (v.rule_key && !next.has(v.rule_key)) {
          if (next === map) next = new Map(map);
          next.set(v.rule_key, v.rule_name || v.field?.name || v.rule_key);
        }
      return next;
    });
  }, [items]);
  if (!snapshotId)
    return (
      <EmptyState>현재 Snapshot이 없습니다.</EmptyState>
    );
  return (
    <>
      {(rules.size > 0 || rule) && (
        <div className="app-toolbar">
          <label>
            파싱 규칙
            <select value={rule} onChange={(e) => setRule(e.target.value)}>
              <option value="">전체</option>
              {[...rules.entries()].map(([key, name]) => (
                <option key={key} value={key}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <span className="app-toolbar-end app-muted app-small" role="status">
            {values.loading ? "" : `${items.length}건 표시`}
          </span>
        </div>
      )}
      <State
        resource={values}
        empty={rule ? "이 파싱 규칙으로 추출된 값이 없습니다." : "추출된 값이 없습니다. 적용 프로파일 탭에서 파싱을 실행하세요."}
        action={
          rule ? (
            <button type="button" onClick={() => setRule("")}>
              필터 해제
            </button>
          ) : undefined
        }
      />
      {items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="추출 결과">
            <thead>
              <tr>
                <th scope="col">필드</th>
                <th scope="col">파싱 규칙</th>
                <th scope="col">값</th>
                <th scope="col">단위</th>
                <th scope="col">원본 위치</th>
                <th scope="col">
                  <span className="app-muted">행동</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.value_id}>
                  <td>
                    {v.field?.name || <span className="app-muted">미지정</span>}
                    {v.record_key && <span className="app-muted app-small"> · {v.record_key}</span>}
                  </td>
                  <td>{v.rule_name || v.rule_key}</td>
                  <td title={v.display_text && v.display_text !== v.value_text ? `원값 ${v.value_text}` : undefined}>{v.display_text ?? v.value_text}</td>
                  <td>{v.unit_normalized || v.field?.unit || ""}</td>
                  <td>{regionLabel(v.first_region?.sheet_name, v.first_region?.range)}</td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      disabled={!v.application_id}
                      onClick={() =>
                        go(reviewRoute({ application_id: v.application_id, rule_key: v.rule_key, sheet_id: v.first_region?.sheet_id, range: v.first_region?.range }))
                      }
                    >
                      원본 보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={values} />
    </>
  );
}

type ProfileLine = DocumentProfile & Partial<Pick<ApplicationRow, "heads_approved" | "heads_total" | "published" | "origin">>;

// 적용 프로파일: 문서 행의 profiles[]를 기본으로, 탭을 열 때 GET /snapshots/{sid}/applications로 검수·발행을 보강한다.
function ProfilesTab({ doc, onReparse }: { doc: DocumentDetailData; onReparse: () => void }) {
  const { go, refresh, changed } = useNavigation();
  const { notify } = useToast();
  // 한 건 재파싱(§4.9)은 한 번에 하나만 돌린다 — 같은 문서를 두 작업이 함께 잡으면 서버가 어차피 막는다.
  const job = useJob();
  const [running, setRunning] = useState("");
  const snapshotId = doc.current_snapshot?.snapshot_id || "";
  const applications = useData<Page<ApplicationRow> | ApplicationRow[]>(snapshotId ? `${snapshotsPath(snapshotId)}/applications` : null, refresh);
  const loaded = Array.isArray(applications.data) ? applications.data : applications.data?.items ?? [];
  const rows: ProfileLine[] = doc.profiles.map((p) => {
    const app = loaded.find((a) => a.application_id === p.application_id);
    return app
      ? { ...p, status: app.profile?.status, heads_approved: app.heads_approved, heads_total: app.heads_total, published: app.published, origin: app.origin }
      : p;
  });
  for (const app of loaded)
    if (!rows.some((r) => r.application_id === app.application_id))
      rows.push({
        ...app.profile,
        application_id: app.application_id,
        state: app.state || (app.heads_total > 0 && app.heads_approved >= app.heads_total ? "approved" : "review"),
        compatibility: app.compatibility,
        heads_approved: app.heads_approved,
        heads_total: app.heads_total,
        published: app.published,
        origin: app.origin,
      });
  const reparseButton = (
    <button type="button" disabled={!snapshotId} onClick={onReparse}>
      다른 프로파일로 파싱
    </button>
  );

  // 이 행의 `다시 파싱`이 서버 가드(§4.9)에 막히는 이유. 눌러서 422를 받고 표 **아래** 오류 줄로 알게 하지 않는다.
  // 상태를 모르면(옛 응답·아직 안 읽음) 막지 않는다 — 화면이 서버보다 엄해지지 않게.
  function reparseBlocked(p: ProfileLine): string {
    if (p.status === "deprecated") return "폐기된 프로파일로는 다시 파싱할 수 없습니다. 적용 기록은 그대로 둡니다.";
    if (p.status && p.status !== "approved" && (p.heads_approved ?? 0) < (p.heads_total ?? 0))
      return "매핑을 모두 승인해야 다시 파싱할 수 있습니다.";
    return "";
  }

  // 같은 프로파일로 이 적용 건 하나만 다시 파싱한다(문서가 바뀌었거나 프로파일이 올라갔을 때).
  // 판정은 프로파일 전체 재파싱과 같은 규칙이고, 결과는 토스트로 말한다.
  async function reparseOne(row: ProfileLine) {
    setRunning(row.application_id);
    const finished = await job.run(`/applications/${encodeURIComponent(row.application_id)}/reparse`, {}, 10);
    setRunning("");
    // 요청 자체가 막혔다(승인되지 않은 프로파일·진행 중 작업 등) — 표 아래 오류 줄이 서버 문구를 그대로 보여 준다.
    if (!finished) return;
    const result = (finished.result || {}) as Partial<ApplicationReparse>;
    const name = result.document_name || doc.document_name;
    const label = profileLabel({ profile_name: result.profile?.name || row.profile_name, rev: result.profile?.rev ?? row.rev });
    if (finished.state === "succeeded") {
      const skipped = isReparseSkipped(result.outcome) || (!isReparseProcessed(result.outcome) && !!result.reason);
      if (skipped)
        notify(
          `${name} · ${label} 다시 파싱 건너뜀 · ${reparseReasonLabel(result.reason) || "사유를 알 수 없습니다"}`,
          result.reason === "review_required"
            ? { label: "원본 보기", onClick: () => go(reviewRoute({ application_id: row.application_id })) }
            : undefined,
        );
      else if (result.extraction && result.extraction.state !== "succeeded")
        // 추출 실패는 작업을 실패로 만들지 않는다(실행 행에만 남는다) — 값 0개로 보이지 않게 따로 말한다.
        notify(
          `${name} · ${label} 다시 맞췄지만 값을 뽑지 못했습니다: ${result.extraction.error?.message || result.extraction.error?.code || "알 수 없는 오류"}`,
        );
      // 추출까지 가지 않았다(구조가 조금 달라 proposed 리비전만 올라갔다) — 값은 하나도 다시 뽑히지 않았고
      // 그 문서는 검수 대기로 내려갔다. '완료'만 말하면 값이 갱신된 줄 안다(§7).
      else if (!result.extraction && result.action !== "extract")
        notify(`${name} · ${label} 다시 파싱 완료 · 검수가 필요합니다`, {
          label: "원본 보기",
          onClick: () => go(reviewRoute({ application_id: row.application_id })),
        });
      // action이 extract면 매칭은 그대로 두고 값만 다시 뽑은 것이다(승인이 끝난 초안 프로파일 경로).
      else notify(
        `${name} · ${label} 다시 파싱 완료${result.extraction ? ` · 값 ${result.extraction.values ?? 0}개` : ""}` +
          (result.action === "extract" ? " · 값만 다시 뽑았습니다" : ""),
      );
      changed();
    } else if (finished.state === "failed") {
      notify(`${name} · ${label} 다시 파싱에 실패했습니다: ${finished.error_message || finished.error_code || "알 수 없는 오류"}`);
      changed();
    } else {
      // job.run은 작업이 끝나야 돌아온다 — 여기까지 왔으면 취소된 것이다(진행 중이라고 말하면 거짓말이다).
      notify(`${name} · ${label} 다시 파싱을 취소했습니다.`);
      changed();
    }
  }
  return (
    <>
      {rows.length === 0 && (
        <EmptyState action={reparseButton}>적용된 파싱 프로파일이 없습니다. 맞는 프로파일을 골라 직접 파싱할 수 있습니다.</EmptyState>
      )}
      {rows.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="적용 프로파일" aria-busy={applications.loading || undefined}>
            <thead>
              <tr>
                <th scope="col">프로파일</th>
                <th scope="col">상태</th>
                <th scope="col">호환</th>
                <th scope="col">검수</th>
                <th scope="col">발행</th>
                <th scope="col">
                  <span className="app-muted">행동</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.application_id}>
                  <td>{profileLabel(p)}</td>
                  <td>
                    <ApplicationStateChip state={p.state} />
                  </td>
                  <td>{compatibilityLabel(p.compatibility)}</td>
                  <td className="num">{p.heads_total !== undefined ? `${p.heads_approved ?? 0}/${p.heads_total}` : <span className="app-muted">…</span>}</td>
                  <td>
                    {p.published === undefined ? <span className="app-muted">…</span> : p.published ? <Chip kind="ok">발행</Chip> : <Chip kind="muted">미발행</Chip>}
                  </td>
                  <td className="app-inline">
                    <button type="button" className="small" onClick={() => go(reviewRoute({ application_id: p.application_id }))}>
                      원본 보기
                    </button>
                    <button
                      type="button"
                      className="small"
                      disabled={job.busy || !!running || !!reparseBlocked(p)}
                      title={
                        reparseBlocked(p) ||
                        (running && running !== p.application_id
                          ? "다른 다시 파싱이 도는 중입니다 — 한 번에 한 건씩 처리합니다."
                          : "이 문서를 같은 프로파일의 현재 리비전으로 다시 맞춥니다(이미 최신이면 아무것도 하지 않습니다).")
                      }
                      onClick={() => reparseOne(p)}
                    >
                      {running === p.application_id ? "다시 파싱 중…" : "다시 파싱"}
                    </button>
                    <button type="button" className="small" onClick={() => go({ screen: "profiles", profile: p.profile_id, document: "", tab: "" })}>
                      프로파일 열기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {job.error && (
        <div className="app-error" role="alert">
          <span>{job.error}</span>
        </div>
      )}
      {running && (
        <p className="app-muted app-small" role="status">
          다시 파싱이 진행 중입니다. 닫아도 상단의 진행 중 작업 표시에서 확인할 수 있습니다.
        </p>
      )}
      {applications.error && (
        <p className="app-muted app-small" role="status">
          검수·발행 상태를 불러오지 못했습니다: {applications.error.message}
        </p>
      )}
      {rows.length > 0 && <div className="app-inline">{reparseButton}</div>}
    </>
  );
}

function SchemasTab({ doc }: { doc: DocumentDetailData }) {
  const { go } = useNavigation();
  return (
    <div className="app-list">
      {doc.schemas.length === 0 && (
        <EmptyState>연결된 파싱 스키마가 없습니다. 파싱 프로파일이 적용되면 그 프로파일의 스키마가 연결됩니다.</EmptyState>
      )}
      {doc.schemas.map((s) => {
        const via = doc.profiles.map(profileLabel).join(", ");
        return (
          <button key={s.schema_key} type="button" className="app-list-item" onClick={() => go({ screen: "schema", schema: s.schema_key, document: "", tab: "", sheet: "" })}>
            <span>
              <strong>{schemaLabel(s)}</strong>
              <small>{via ? `프로파일 ${via} 경유 · ` : ""}파싱 스키마 화면에서 구조 보기 ›</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// "다른 프로파일로 파싱": 프로파일 선택 → POST /snapshots/{sid}/applications?wait=10 {profile_id}. 10초를 넘기면 작업은 JobBar에서 이어진다.
function ReparsePicker({ snapshotId, onClose, onApplied }: { snapshotId: string; onClose: () => void; onApplied: (applicationId: string | null) => void }) {
  const { go } = useNavigation();
  const { notify } = useToast();
  const [profileId, setProfileId] = useState("");
  const profiles = useData<Page<ProfileRow>>("/profiles");
  const job = useJob();
  const running = isJobActive(job.job);
  async function run() {
    const result = await job.run(`${snapshotsPath(snapshotId)}/applications`, { profile_id: profileId }, 10);
    if (!result) return;
    if (result.state === "succeeded") {
      const applicationId =
        (result.result as { application_id?: string } | null)?.application_id || (result as unknown as { application_id?: string }).application_id || null;
      notify("파싱을 적용했습니다.", applicationId ? { label: "원본 보기", onClick: () => go(reviewRoute({ application_id: applicationId })) } : undefined);
      onApplied(applicationId);
      onClose();
    } else if (result.state === "failed") {
      notify(`파싱에 실패했습니다: ${result.error_message || result.error_code || "알 수 없는 오류"}`);
      onApplied(null);
    } else {
      onApplied(null);
      onClose();
    }
  }
  let status: ReactNode = null;
  if (job.error)
    status = (
      <span className="app-error" role="alert">
        {job.error}
      </span>
    );
  else if (running)
    status = (
      <span className="app-note" role="status">
        파싱 작업이 진행 중입니다. 닫아도 상단의 진행 중 작업 표시에서 확인할 수 있습니다.
      </span>
    );
  return (
    <div className="app-card tight" role="group" aria-label="다른 프로파일로 파싱">
      <div className="app-toolbar">
        <label className="app-grow">
          파싱 프로파일
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={job.busy}>
            <option value="">프로파일 선택</option>
            {profiles.data?.items.map((p) => (
              <option key={p.profile_id} value={p.profile_id}>
                {profileLabel({ profile_name: p.profile_name, rev: p.current_rev })}
                {p.status === "draft" ? " (초안)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="primary" disabled={!profileId || job.busy} onClick={run}>
          {job.busy ? "파싱 중…" : "파싱 실행"}
        </button>
        <button type="button" onClick={onClose}>
          {running ? "닫기" : "취소"}
        </button>
      </div>
      {profiles.error && (
        <p className="app-error" role="alert">
          프로파일 목록을 불러오지 못했습니다: {profiles.error.message}
        </p>
      )}
      {status}
    </div>
  );
}
