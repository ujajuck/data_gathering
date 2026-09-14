// 파싱 프로파일 상세(§7 Profiles): 탭 기본 정보 · 규칙 · 필드 매핑 · 테스트 · JSON · 변경 이력 (?profile=&tab=&rev=).
// 진입 호출: GET /profiles/{id} + (기본 정보) GET /profiles/{id}/documents. 정의(canonical JSON)는 규칙·JSON 탭에서만
// GET /profiles/{id}/revisions/{rev}로 읽고, 저장은 PUT /profiles/{id} {definition}.
import { useEffect, useMemo, useState } from "react";
import {
  Pager,
  State,
  api,
  downloadFile,
  errorMessage,
  formatDateTime,
  profileLabel,
  reviewRoute,
  schemaLabel,
  snapshotLabel,
  useData,
  useDebounced,
  useJob,
  useNavigation,
  usePage,
  useToast,
  withQuery,
} from "./client";
import type { PageResource, Resource } from "./client";
import { compatibilityLabel } from "./types";
import type {
  DocumentRow,
  ProfileDetail as ProfileDetailData,
  ProfileDocumentRow,
  ProfileImportPreview,
  ProfileSaveResult,
  RevisionRow,
} from "./types";
import { Chip, ProfileStatusChip, StatusChip, Tabs } from "./ui";
import { parseDefinition, pretty, problemText, sheetRoleSummary } from "./profileModel";
import type { Problem, ProfileDefinition } from "./profileModel";
import { setProfileDraft } from "./profileDraft";
import ProfileRules from "./ProfileRules";

type Tab = "info" | "rules" | "mapping" | "test" | "json" | "history";
const TABS: { id: Tab; label: string }[] = [
  { id: "info", label: "기본 정보" },
  { id: "rules", label: "규칙" },
  { id: "mapping", label: "필드 매핑" },
  { id: "test", label: "테스트" },
  { id: "json", label: "JSON" },
  { id: "history", label: "변경 이력" },
];

// 호환성 라벨은 types.ts의 공용 표(문서 등록·Source Review와 같은 문구).
export { compatibilityLabel };

// 리비전 JSON 응답: canonical 객체 그대로 또는 {definition: {...}} 봉투.
function unwrapDefinition(data: unknown): ProfileDefinition | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.rules) && record.definition && typeof record.definition === "object")
    return record.definition as ProfileDefinition;
  return record as ProfileDefinition;
}

export default function ProfileDetail({ profileId }: { profileId: string }) {
  const { route, go, refresh, changed } = useNavigation();
  const { notify } = useToast();
  const base = "/profiles/" + encodeURIComponent(profileId);
  const detail = useData<ProfileDetailData>(base, refresh);
  const profile = detail.data;
  const tab = (TABS.some((t) => t.id === route.tab) ? route.tab : "info") as Tab;
  const documents = usePage<ProfileDocumentRow>(tab === "info" || tab === "test" || tab === "json" ? base + "/documents" : null, refresh);
  const viewingRev = tab === "json" && route.rev && profile && route.rev !== String(profile.current_rev) ? route.rev : "";
  const definitionPath =
    profile && (tab === "rules" || tab === "json") ? `${base}/revisions/${encodeURIComponent(viewingRev || String(profile.current_rev))}` : null;
  const definitionRaw = useData<unknown>(definitionPath, refresh);
  const definition = useMemo<Resource<ProfileDefinition>>(
    () => ({ ...definitionRaw, data: unwrapDefinition(definitionRaw.data) }),
    [definitionRaw],
  );
  const reparse = useJob();
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");

  async function runReparse(mode: "rematch" | "fill") {
    setMessage("");
    const job = await reparse.run(base + "/reparse", { mode });
    if (!job) return;
    const result = (job.result || {}) as { queued?: number; skipped?: { document_name: string; reason: string }[] };
    if (job.state === "succeeded") {
      const skipped = result.skipped?.length ?? 0;
      notify(`재파싱(${mode}) 완료 · ${result.queued ?? 0}건 처리${skipped ? ` · ${skipped}건 건너뜀` : ""}`);
      changed();
    } else if (job.state === "failed") setMessage(job.error_message || "재파싱에 실패했습니다.");
    else notify(`재파싱(${mode})이 작업 내역에서 계속 진행됩니다.`);
  }

  // 새 리비전 저장(규칙 폼·JSON 탭 공용). 성공하면 true.
  async function saveDefinition(next: ProfileDefinition): Promise<boolean> {
    setSaveError("");
    try {
      const result = await api<ProfileSaveResult>(base, { definition: next }, { method: "PUT" });
      const warnings = result.report?.warnings?.length ?? 0;
      notify(`${result.profile_name || profile?.profile_name} v${result.current_rev} 저장됨${warnings ? ` · 경고 ${warnings}건` : ""}`);
      go({ rev: "" });
      changed();
      return true;
    } catch (failure) {
      setSaveError(errorMessage(failure));
      return false;
    }
  }

  return (
    <section className="app-card" aria-label="프로파일 상세">
      <State resource={detail} />
      {profile && (
        <>
          <div className="app-card-head">
            <div className="app-inline">
              <h2>{profileLabel({ profile_name: profile.profile_name, rev: profile.current_rev })}</h2>
              <ProfileStatusChip status={profile.status} />
              <span className="app-muted app-small">{schemaLabel({ name: profile.schema?.name || "-" })}</span>
            </div>
            <div className="app-inline">
              <button
                type="button"
                className="small"
                disabled={profile.status !== "approved" || reparse.busy}
                title={profile.status !== "approved" ? "승인된 프로파일만 재파싱할 수 있습니다." : "적용 문서와 프로파일 없는 문서를 현재 리비전으로 다시 판정합니다."}
                onClick={() => runReparse("rematch")}
              >
                재파싱(rematch)
              </button>
              <button
                type="button"
                className="small"
                disabled={profile.status !== "approved" || reparse.busy}
                title={profile.status !== "approved" ? "승인된 프로파일만 재파싱할 수 있습니다." : "승인됐지만 아직 추출되지 않은 문서를 추출합니다."}
                onClick={() => runReparse("fill")}
              >
                재파싱(fill)
              </button>
            </div>
          </div>
          {(reparse.error || message || saveError) && (
            <div className="app-error" role="alert">
              <span>{reparse.error || message || saveError}</span>
            </div>
          )}
          {reparse.busy && (
            <p className="app-muted app-small" role="status">
              재파싱 진행 중…
            </p>
          )}
          <Tabs tabs={TABS} value={tab} onChange={(id) => go({ tab: id, rev: "" })} label="프로파일 상세 탭" />
          {tab === "info" && <InfoTab profile={profile} detail={detail} documents={documents} base={base} />}
          {tab === "rules" && (
            <ProfileRules profile={profile} definition={definition} onSave={saveDefinition} />
          )}
          {tab === "mapping" && <MappingTab profile={profile} />}
          {tab === "test" && <TestTab profileId={profileId} documents={documents} />}
          {tab === "json" && (
            <JsonTab
              profile={profile}
              definition={definition}
              viewingRev={viewingRev}
              documents={documents}
              onSave={saveDefinition}
              base={base}
            />
          )}
          {tab === "history" && <HistoryTab base={base} currentRev={profile.current_rev} />}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 기본 정보

function InfoTab({
  profile,
  detail,
  documents,
  base,
}: {
  profile: ProfileDetailData;
  detail: Resource<ProfileDetailData>;
  documents: PageResource<ProfileDocumentRow>;
  base: string;
}) {
  const { go } = useNavigation();
  const { notify } = useToast();
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const rows = documents.items;
  const candidates = rows.filter((r) => r.heads_total > 0 && r.heads_approved === r.heads_total);
  const roles = Object.entries(profile.sheet_roles || {});

  async function approve(row: ProfileDocumentRow) {
    setError("");
    setPending(row.application_id);
    const previousDetail = detail.data;
    const previousDocuments = documents.data;
    // 낙관적 갱신: 상태 칩·대표 문서·대표 표시를 먼저 바꾸고 실패하면 되돌린다.
    detail.setData((current) =>
      current
        ? {
            ...current,
            status: "approved",
            auto_approval_active: true,
            reference: {
              application_id: row.application_id,
              document_id: row.document_id,
              document_name: row.document_name,
              snapshot: { snapshot_id: row.snapshot.snapshot_id, revision_no: row.snapshot.revision_no, captured_at: row.snapshot.captured_at || "" },
              approved_at: new Date().toISOString(),
              profile_rev: current.current_rev,
            },
          }
        : current,
    );
    documents.setData((current) =>
      current ? { ...current, items: current.items.map((r) => ({ ...r, is_reference: r.application_id === row.application_id })) } : current,
    );
    try {
      const result = await api<Partial<ProfileDetailData> | null>(base + "/approve", { application_id: row.application_id });
      // 응답이 프로파일 상세면 상태·대표 문서를 서버 값으로 맞춘다(응답이 비어 있으면 낙관적 상태 유지).
      if (result && typeof result === "object" && result.profile_id && result.status)
        detail.setData((current) =>
          current
            ? {
                ...current,
                status: result.status!,
                auto_approval_active: result.auto_approval_active ?? current.auto_approval_active,
                reference: result.reference || current.reference,
              }
            : current,
        );
      notify(`${row.document_name}을(를) 대표 문서로 승인했습니다. 재파싱(rematch)이 이어서 진행됩니다.`);
    } catch (failure) {
      detail.setData(previousDetail);
      documents.setData(previousDocuments);
      setError(errorMessage(failure));
    } finally {
      setPending("");
    }
  }

  return (
    <div className="app-stack">
      {profile.description && <p>{profile.description}</p>}
      <dl className="app-kv">
        <dt>상태</dt>
        <dd>
          <ProfileStatusChip status={profile.status} />
        </dd>
        <dt>연결 스키마</dt>
        <dd>{profile.schema?.name || "-"}</dd>
        <dt>대표 문서</dt>
        <dd>
          {profile.reference ? (
            <span className="app-inline">
              <span>
                {profile.reference.document_name} r{profile.reference.snapshot.revision_no}
              </span>
              <span className="app-muted app-small">승인 {formatDateTime(profile.reference.approved_at)} · 기준 v{profile.reference.profile_rev}</span>
              <button type="button" className="link small" onClick={() => go(reviewRoute({ application_id: profile.reference!.application_id }))}>
                Source Review 열기
              </button>
            </span>
          ) : (
            "없음"
          )}
        </dd>
        <dt>자동 승인</dt>
        <dd>
          {profile.auto_approval_active ? (
            <span>
              <Chip kind="ok">활성</Chip> <span className="app-muted app-small">대표 문서와 동일한 구조의 문서는 사람 개입 없이 승인·추출됩니다.</span>
            </span>
          ) : (
            <span>
              <Chip kind="muted">비활성</Chip>{" "}
              <span className="app-muted app-small">
                {profile.status !== "approved"
                  ? "프로파일을 승인하면 활성화됩니다."
                  : "새 리비전 저장 뒤에는 대표 문서를 다시 승인하거나 재파싱(rematch)을 실행해야 재개됩니다."}
              </span>
            </span>
          )}
        </dd>
        <dt>적용 문서</dt>
        <dd>
          {profile.document_count}개{profile.success_rate !== null && profile.success_rate !== undefined ? ` · 성공률 ${Math.round(profile.success_rate * 100)}%` : ""}
        </dd>
        <dt>최근 수정</dt>
        <dd>{formatDateTime(profile.updated_at)}</dd>
      </dl>
      <h3>시트 역할 ({roles.length})</h3>
      {roles.length === 0 ? (
        <p className="app-muted">시트 역할이 없습니다.</p>
      ) : (
        <ul className="app-list" aria-label="시트 역할">
          {roles.map(([role, spec]) => (
            <li className="app-list-item" key={role}>
              <span>
                <strong>{role}</strong>
                <small>{sheetRoleSummary(spec)}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      <h3>적용 문서</h3>
      {error && (
        <div className="app-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <State resource={documents} empty="이 프로파일이 적용된 문서가 없습니다. 문서 화면에서 '다른 프로파일로 파싱'으로 적용해 보세요." />
      {rows.length > 0 && (
        <>
          {candidates.length === 0 && profile.status !== "approved" && (
            <p className="app-note">승인 후보가 없습니다. Source Review에서 매핑을 모두 승인한 문서가 있어야 '이 문서로 승인'할 수 있습니다.</p>
          )}
          <div className="app-table-wrap">
            <table className="app-table" aria-label="적용 문서">
              <thead>
                <tr>
                  <th scope="col">문서명</th>
                  <th scope="col">Snapshot</th>
                  <th scope="col">호환</th>
                  <th scope="col">검수</th>
                  <th scope="col">발행</th>
                  <th scope="col">대표</th>
                  <th scope="col">상태</th>
                  <th scope="col">행동</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const approvable = row.heads_total > 0 && row.heads_approved === row.heads_total;
                  return (
                    <tr key={row.application_id} className={row.is_reference ? "selected" : undefined}>
                      <td>{row.document_name}</td>
                      <td>{snapshotLabel(row.snapshot, { history: true })}</td>
                      <td>{compatibilityLabel(row.compatibility)}</td>
                      <td className="num">
                        {row.heads_approved}/{row.heads_total}
                      </td>
                      <td>{row.published ? <Chip kind="ok">발행됨</Chip> : <Chip kind="muted">미발행</Chip>}</td>
                      <td>{row.is_reference ? <Chip kind="blue">대표</Chip> : <span className="app-muted">-</span>}</td>
                      <td>
                        <StatusChip status={row.document_status || row.status || "-"} />
                      </td>
                      <td>
                        <span className="app-inline">
                          <button type="button" className="small" onClick={() => go(reviewRoute({ application_id: row.application_id }))}>
                            Source Review 열기
                          </button>
                          {approvable && !row.is_reference && (
                            <button
                              type="button"
                              className="small primary"
                              disabled={pending === row.application_id}
                              onClick={() => approve(row)}
                            >
                              이 문서로 승인
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pager page={documents} />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 필드 매핑

function MappingTab({ profile }: { profile: ProfileDetailData }) {
  const unmapped = profile.rules.filter((r) => !r.field).length;
  return (
    <div className="app-stack">
      {unmapped > 0 ? (
        <p className="app-note" role="status">
          필드가 지정되지 않은 파싱 규칙 {unmapped}개 — 규칙 탭에서 필드를 연결해야 승인·추출할 수 있습니다.
        </p>
      ) : (
        <p className="app-muted app-small" role="status">
          모든 파싱 규칙이 필드에 연결되어 있습니다.
        </p>
      )}
      <div className="app-table-wrap">
        <table className="app-table" aria-label="필드 매핑">
          <thead>
            <tr>
              <th scope="col">파싱 규칙</th>
              <th scope="col">필드</th>
              <th scope="col">타입</th>
              <th scope="col">단위</th>
              <th scope="col">상태</th>
            </tr>
          </thead>
          <tbody>
            {profile.rules.map((rule) => (
              <tr key={rule.rule_key} className={rule.field ? undefined : "app-unmapped"} data-unmapped={rule.field ? undefined : "true"}>
                <td>
                  <strong>{rule.rule_name}</strong> <code>{rule.rule_key}</code>
                </td>
                <td>
                  {rule.field ? (
                    <span>
                      {rule.field.name} <code>{rule.field.key}</code>
                    </span>
                  ) : (
                    <Chip kind="warn">미지정</Chip>
                  )}
                </td>
                <td>{rule.field?.type || String(rule.value_spec?.type || "-")}</td>
                <td>{rule.field?.unit || String(rule.value_spec?.unit || "-")}</td>
                <td>{rule.status || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 테스트

type DocumentChoice = { snapshot_id: string; document_name: string; document_id: string };

function TestTab({ profileId, documents }: { profileId: string; documents: PageResource<ProfileDocumentRow> }) {
  const { go } = useNavigation();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const search = usePage<DocumentRow>(q ? withQuery("/documents", { q }) : null);
  const [choice, setChoice] = useState<DocumentChoice | null>(null);
  const applied: DocumentChoice[] = documents.items.map((r) => ({ snapshot_id: r.snapshot.snapshot_id, document_name: r.document_name, document_id: r.document_id }));
  const found: DocumentChoice[] = q
    ? search.items
        .filter((d) => d.current_snapshot && !applied.some((a) => a.document_id === d.document_id))
        .map((d) => ({ snapshot_id: d.current_snapshot!.snapshot_id, document_name: d.document_name, document_id: d.document_id }))
    : [];
  const run = () => {
    if (!choice) return;
    go({ test: profileId, snapshot: choice.snapshot_id, review: "", rule: "", range: "", sheet: "" });
  };
  const option = (doc: DocumentChoice, hint: string) => (
    <label className="app-check app-list-item" key={doc.document_id}>
      <input
        type="radio"
        name="test-document"
        aria-label={doc.document_name}
        checked={choice?.document_id === doc.document_id}
        onChange={() => setChoice(doc)}
      />
      <span>
        <strong>{doc.document_name}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );
  return (
    <div className="app-stack">
      <p className="app-muted app-small">문서를 고르고 테스트를 실행하면 저장 없이 현재 리비전을 적용한 결과를 Source Review에서 확인합니다.</p>
      <div className="app-toolbar">
        <label className="app-grow">
          문서 검색
          <input placeholder="다른 문서를 찾으려면 문서명 입력" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={!choice} onClick={run}>
          테스트 실행
        </button>
      </div>
      <h3>적용 문서</h3>
      <State resource={documents} empty="적용된 문서가 없습니다. 위에서 문서를 검색해 선택하세요." />
      {applied.length > 0 && (
        <div className="app-list" role="radiogroup" aria-label="적용 문서">
          {applied.map((doc) => option(doc, "이 프로파일이 적용된 문서"))}
        </div>
      )}
      {q && (
        <>
          <h3>검색 결과</h3>
          <State resource={search} empty="조건에 맞는 문서가 없습니다." isEmpty={!search.loading && !search.error && found.length === 0} />
          {found.length > 0 && (
            <div className="app-list" role="radiogroup" aria-label="검색 결과">
              {found.map((doc) => option(doc, "검색된 문서"))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- JSON

function JsonTab({
  profile,
  definition,
  viewingRev,
  documents,
  onSave,
  base,
}: {
  profile: ProfileDetailData;
  definition: Resource<ProfileDefinition>;
  viewingRev: string;
  documents: PageResource<ProfileDocumentRow>;
  onSave: (next: ProfileDefinition) => Promise<boolean>;
  base: string;
}) {
  const { go } = useNavigation();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [busy, setBusy] = useState<"" | "check" | "save" | "export">("");
  const [error, setError] = useState("");
  const [testSnapshot, setTestSnapshot] = useState("");
  const loaded = definition.data ? pretty(definition.data) : "";
  useEffect(() => {
    setText(loaded);
    setPreview(null);
  }, [loaded]);
  const parsed = useMemo(() => parseDefinition(text), [text]);
  const dirty = !!loaded && text !== loaded;
  const readOnly = !!viewingRev;
  const candidates = documents.items;
  const snapshotId = testSnapshot || profile.reference?.snapshot.snapshot_id || candidates[0]?.snapshot.snapshot_id || "";

  async function check() {
    if (!parsed.definition) return;
    setBusy("check");
    setError("");
    try {
      setPreview(await api<ProfileImportPreview>("/profiles/import-preview", { schema_key: profile.schema.key, definition: parsed.definition }));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    if (!parsed.definition) return;
    setBusy("save");
    await onSave(parsed.definition);
    setBusy("");
  }
  async function exportJson() {
    setBusy("export");
    setError("");
    try {
      await downloadFile(base + "/export", `${profile.profile_name}_v${profile.current_rev}.json`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy("");
    }
  }
  function testDraft() {
    if (!parsed.definition || !snapshotId) return;
    setProfileDraft({ schema_key: profile.schema.key, definition: parsed.definition, profile_name: profile.profile_name });
    go({ test: "draft", snapshot: snapshotId, review: "", rule: "", range: "", sheet: "" });
  }
  const errors: Problem[] = (preview?.errors as Problem[] | undefined) || [];
  const warnings: Problem[] = (preview?.warnings as Problem[] | undefined) || [];
  return (
    <div className="app-stack">
      {readOnly && (
        <p className="app-note" role="status">
          리비전 v{viewingRev}을(를) 읽기 전용으로 보고 있습니다.{" "}
          <button type="button" className="link small" onClick={() => go({ rev: "" })}>
            현재 리비전(v{profile.current_rev})으로 돌아가기
          </button>
        </p>
      )}
      <State resource={definition} />
      {definition.data && (
        <>
          <label>
            프로파일 JSON
            <textarea
              className="app-json-editor"
              rows={22}
              spellCheck={false}
              readOnly={readOnly}
              aria-invalid={parsed.error ? true : undefined}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          {parsed.error ? (
            <div className="app-error" role="alert">
              <span>{parsed.error}</span>
            </div>
          ) : (
            <p className="app-muted app-small" role="status">
              {dirty ? "저장되지 않은 변경이 있습니다." : `현재 리비전 v${viewingRev || profile.current_rev}과 같습니다.`}
            </p>
          )}
          {error && (
            <div className="app-error" role="alert">
              <span>{error}</span>
            </div>
          )}
          {preview && (
            <div className="app-stack app-problems" aria-label="검증 결과">
              <p className="app-small">
                형식 <Chip kind="blue">{preview.format_detected}</Chip>{" "}
                {errors.length === 0 ? <Chip kind="ok">오류 없음</Chip> : <Chip kind="err">오류 {errors.length}</Chip>}
                {warnings.length > 0 && <Chip kind="warn">경고 {warnings.length}</Chip>}
              </p>
              {errors.length > 0 && (
                <div className="app-error" role="alert">
                  <ul aria-label="오류">
                    {errors.map((p, i) => (
                      <li key={i}>{problemText(p)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.length > 0 && (
                <ul className="app-note" aria-label="경고">
                  {warnings.map((p, i) => (
                    <li key={i}>{problemText(p)}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="app-toolbar">
            <button type="button" disabled={!parsed.definition || !!busy} onClick={check}>
              검증
            </button>
            <button type="button" className="primary" disabled={!parsed.definition || readOnly || !!busy} onClick={save}>
              새 리비전 저장
            </button>
            <button type="button" disabled={!!busy} onClick={exportJson}>
              내보내기
            </button>
            <span className="app-toolbar-end app-inline">
              <label>
                테스트 문서
                <select value={snapshotId} onChange={(e) => setTestSnapshot(e.target.value)} disabled={candidates.length === 0}>
                  {candidates.length === 0 && <option value="">적용 문서 없음</option>}
                  {candidates.map((row) => (
                    <option key={row.application_id} value={row.snapshot.snapshot_id}>
                      {row.document_name} r{row.snapshot.revision_no}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={!parsed.definition || !snapshotId}
                title={!snapshotId ? "테스트할 문서가 없습니다. 테스트 탭에서 문서를 검색하세요." : "저장하지 않은 정의를 선택한 문서에 적용해 봅니다."}
                onClick={testDraft}
              >
                미저장 정의로 테스트
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 변경 이력

function HistoryTab({ base, currentRev }: { base: string; currentRev: number }) {
  const { go } = useNavigation();
  const revisions = usePage<RevisionRow>(base + "/revisions");
  return (
    <div className="app-stack">
      <State resource={revisions} empty="변경 이력이 없습니다." />
      {revisions.items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="변경 이력">
            <thead>
              <tr>
                <th scope="col">리비전</th>
                <th scope="col">시각</th>
                <th scope="col">작성자</th>
                <th scope="col">요약</th>
                <th scope="col">행동</th>
              </tr>
            </thead>
            <tbody>
              {revisions.items.map((row) => (
                <tr key={row.rev}>
                  <td>
                    r{row.rev} {row.rev === currentRev && <Chip kind="blue">현재</Chip>}
                  </td>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>{row.created_by || "-"}</td>
                  <td className="app-wrap">{row.summary || row.format_detected || "-"}</td>
                  <td>
                    <button type="button" className="small" onClick={() => go({ tab: "json", rev: String(row.rev) })}>
                      이 리비전 보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={revisions} />
    </div>
  );
}
