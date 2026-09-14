// 문서 상세 드로어(§7, 모달: 형제 inert·focus trap·Esc). URL ?document=&tab=&sheet=.
// 헤더 = 문서명 + 상태 칩 + 현재 Snapshot(날짜 + 최신) · 관계 카드 `문서 → 프로파일 vN → 스키마 vN` · 접힌 `Snapshot 이력`
// (GET /documents/{id}/snapshots는 펼칠 때만) · 탭 `파일 보기(시트 목록 + SheetViewer readonly) · 추출 결과(GET /snapshots/{sid}/values,
// 규칙 필터, 행마다 원본 보기) · 적용 프로파일(GET /snapshots/{sid}/applications로 검수·발행 보강) · 연결 스키마`.
// 행동: 원본 보기 · 다른 프로파일로 파싱(프로파일 선택 → POST /snapshots/{sid}/applications?wait=10) · 데이터 빌드에 추가.
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
import type { ApplicationRow, DocumentDetail as DocumentDetailData, DocumentProfile, DocumentStatus, Page, ProfileRow, SheetRow, SnapshotRef, ValueRow } from "./types";
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

export default function DocumentDetail({ documentId, onAddToBuild }: { documentId: string; onAddToBuild: (id: string) => void }) {
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
          </>
        )
      }
    >
      <State resource={document} />
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
  const { go } = useNavigation();
  const [rule, setRule] = useState("");
  const [rules, setRules] = useState<Map<string, string>>(new Map());
  const values = usePage<ValueRow>(snapshotId ? withQuery(`${snapshotsPath(snapshotId)}/values`, { rule_key: rule }) : null);
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
  const { go } = useNavigation();
  const snapshotId = doc.current_snapshot?.snapshot_id || "";
  const applications = useData<Page<ApplicationRow> | ApplicationRow[]>(snapshotId ? `${snapshotsPath(snapshotId)}/applications` : null);
  const loaded = Array.isArray(applications.data) ? applications.data : applications.data?.items ?? [];
  const rows: ProfileLine[] = doc.profiles.map((p) => {
    const app = loaded.find((a) => a.application_id === p.application_id);
    return app ? { ...p, heads_approved: app.heads_approved, heads_total: app.heads_total, published: app.published, origin: app.origin } : p;
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
