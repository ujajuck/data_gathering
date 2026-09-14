// 파싱 프로파일 상세(§7 Profiles) — 탭 없는 한 화면(?profile=&rev=).
// 구성: 상단 요약줄(프로파일명 vN · 상태 · 연결 스키마 · 대표 문서 · 적용 문서 수) + 정의 JSON 편집기(검증 오류·경고,
// 저장하면 새 리비전) + `테스트`(문서를 고르면 Source Review 테스트 모드) + 하단 `변경 이력`(리비전을 열면 그 JSON을 읽기 전용으로).
// 진입 호출 3개: GET /profiles/{id} · GET /profiles/{id}/revisions/{현재 rev} · GET /profiles/{id}/revisions.
// 적용 문서 목록은 '대표 문서 지정'·'테스트' 팝오버를 열 때만 읽는다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pager,
  State,
  api,
  downloadFile,
  errorMessage,
  formatDateTime,
  profileLabel,
  reviewRoute,
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
import { Chip, ProfileStatusChip } from "./ui";
import DeleteDialog from "./DeleteDialog";
import { parseDefinition, pretty, problemText } from "./profileModel";
import type { Problem, ProfileDefinition } from "./profileModel";

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

export const isApprovable = (row: ProfileDocumentRow) => row.heads_total > 0 && row.heads_approved === row.heads_total;

export default function ProfileDetail({ profileId }: { profileId: string }) {
  const { route, go, refresh, changed } = useNavigation();
  const { notify } = useToast();
  const base = "/profiles/" + encodeURIComponent(profileId);
  const detail = useData<ProfileDetailData>(base, refresh);
  const profile = detail.data;
  // 열려 있는 팝오버: 대표 문서 지정 · 테스트 문서 고르기. 적용 문서 목록은 둘 중 하나가 열릴 때만 읽는다.
  const [popover, setPopover] = useState<"" | "reference" | "test">("");
  const documents = usePage<ProfileDocumentRow>(popover ? base + "/documents" : null, refresh);
  const viewingRev = route.rev && profile && route.rev !== String(profile.current_rev) ? route.rev : "";
  const definitionPath = profile ? `${base}/revisions/${encodeURIComponent(viewingRev || String(profile.current_rev))}` : null;
  const definitionRaw = useData<unknown>(definitionPath, refresh);
  const definition = useMemo<Resource<ProfileDefinition>>(
    () => ({ ...definitionRaw, data: unwrapDefinition(definitionRaw.data) }),
    [definitionRaw],
  );
  const reparse = useJob();
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // 정의 편집기가 "저장 안 한 편집이 있다"고 알려 주는 자리(재파싱 전 확인용).
  const dirtyRef = useRef(false);
  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
  }, []);

  // 폐기 — 적용된 문서가 있어 지울 수 없는 프로파일의 사용을 멈추는 길(§4.2.1).
  async function deprecate() {
    if (!window.confirm(`'${profile?.profile_name}'을(를) 폐기합니다. 새 문서에 더 이상 붙지 않습니다. 계속할까요?`)) return;
    setMessage("");
    setBusy(true);
    try {
      await api(base + "/deprecate", {});
      notify(`${profile?.profile_name} 프로파일을 폐기했습니다.`);
      changed();
    } catch (failure) {
      setMessage(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  async function runReparse(mode: "rematch" | "fill") {
    // 편집기에 저장하지 않은 편집이 있으면 먼저 묻는다 — 재파싱이 정의를 다시 읽어 편집을 덮어쓴다.
    if (dirtyRef.current && !window.confirm("저장하지 않은 정의 편집이 있습니다. 편집을 버리고 재파싱할까요?")) return;
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

  // 새 리비전 저장. 성공하면 true.
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
            </div>
            <div className="app-inline app-popover-anchor">
              <button type="button" className="small" aria-expanded={popover === "test"} onClick={() => setPopover(popover === "test" ? "" : "test")}>
                테스트
              </button>
              {popover === "test" && <TestPopover profileId={profileId} documents={documents} onClose={() => setPopover("")} />}
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
              <ExportButton base={base} profile={profile} />
              {profile.status !== "deprecated" && (
                <button
                  type="button"
                  className="small"
                  disabled={busy}
                  title="더 이상 이 프로파일을 새 문서에 붙이지 않습니다. 이미 적용된 문서와 추출값은 그대로 둡니다."
                  onClick={deprecate}
                >
                  폐기
                </button>
              )}
              {/* 적용된 문서가 없을 때만 지울 수 있다(§4.2.1) — 언제나 실패하는 버튼은 두지 않는다. */}
              {profile.document_count === 0 && (
                <button type="button" className="small danger" disabled={busy} onClick={() => setDeleting(true)}>
                  삭제
                </button>
              )}
            </div>
          </div>
          {profile.description && <p className="app-muted app-small">{profile.description}</p>}
          <SummaryBar profile={profile} detail={detail} documents={documents} base={base} popover={popover} onPopover={setPopover} />
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
          {deleting && (
            <DeleteDialog
              label="프로파일 삭제"
              message={`'${profile.profile_name}'과(와) 규칙 ${profile.rules?.length ?? 0}개를 지웁니다. 되돌릴 수 없습니다.`}
              busyLabel="프로파일을 지우는 중…"
              onCancel={() => setDeleting(false)}
              onShowBlocker={() => setDeleting(false)}
              onConfirm={async () => {
                await api(base, undefined, { method: "DELETE" });
                setDeleting(false);
                notify(`'${profile.profile_name}' 프로파일을 지웠습니다.`);
                go({ profile: "" });
                changed();
              }}
            />
          )}
          <DefinitionEditor profile={profile} definition={definition} viewingRev={viewingRev} onSave={saveDefinition} onDirty={markDirty} />
          <History base={base} currentRev={profile.current_rev} />
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- 요약줄(+ 대표 문서 지정 · 테스트 팝오버)

function SummaryBar({
  profile,
  detail,
  documents,
  base,
  popover,
  onPopover,
}: {
  profile: ProfileDetailData;
  detail: Resource<ProfileDetailData>;
  documents: PageResource<ProfileDocumentRow>;
  base: string;
  popover: "" | "reference" | "test";
  onPopover: (next: "" | "reference" | "test") => void;
}) {
  const { go } = useNavigation();
  return (
    <dl className="app-kv app-summary-bar" aria-label="프로파일 요약">
      <dt>연결 스키마</dt>
      <dd>{profile.schema?.name || "-"}</dd>
      <dt>대표 문서</dt>
      <dd>
        <span className="app-inline app-popover-anchor">
          {profile.reference ? (
            <>
              <span>
                {profile.reference.document_name} r{profile.reference.snapshot.revision_no}
              </span>
              <span className="app-muted app-small">승인 {formatDateTime(profile.reference.approved_at)} · 기준 v{profile.reference.profile_rev}</span>
              {profile.auto_approval_active && <Chip kind="ok">자동 승인</Chip>}
              <button type="button" className="link small" onClick={() => go(reviewRoute({ application_id: profile.reference!.application_id }))}>
                Source Review 열기
              </button>
            </>
          ) : (
            <span className="app-muted">없음</span>
          )}
          <button type="button" className="small" aria-expanded={popover === "reference"} onClick={() => onPopover(popover === "reference" ? "" : "reference")}>
            대표 문서 지정
          </button>
          {popover === "reference" && (
            <ReferencePopover profile={profile} detail={detail} documents={documents} base={base} onClose={() => onPopover("")} />
          )}
        </span>
      </dd>
      <dt>적용 문서</dt>
      <dd>{profile.document_count}개</dd>
    </dl>
  );
}

// 팝오버 틀: 바깥 클릭·Escape로 닫힌다.
function Popover({ label, onClose, align = "left", children }: { label: string; onClose: () => void; align?: "left" | "right"; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const anchor = box.current?.parentElement;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    // 여는 버튼에 초점이 남아 있는 동안에도 Escape로 닫히게 문서에서 받는다(아래 onKeyDown은 팝오버 안쪽용).
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose]);
  return (
    <div
      className={"app-popover " + align}
      role="group"
      aria-label={label}
      ref={box}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="app-popover-head">
        <strong>{label}</strong>
        <button type="button" className="app-popover-close" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      {children}
    </div>
  );
}

// §4.8 프로파일 승인 진입점: 매핑을 모두 승인한 적용 건만 보여 준다.
function ReferencePopover({
  profile,
  detail,
  documents,
  base,
  onClose,
}: {
  profile: ProfileDetailData;
  detail: Resource<ProfileDetailData>;
  documents: PageResource<ProfileDocumentRow>;
  base: string;
  onClose: () => void;
}) {
  const { notify } = useToast();
  const [error, setError] = useState("");
  const [pending, setPending] = useState("");
  const rows = documents.items.filter((row) => isApprovable(row) && !row.is_reference);

  async function approve(row: ProfileDocumentRow) {
    setError("");
    setPending(row.application_id);
    const previousDetail = detail.data;
    const previousDocuments = documents.data;
    // 낙관적 갱신: 상태 칩·대표 문서를 먼저 바꾸고 실패하면 되돌린다.
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
      onClose();
    } catch (failure) {
      detail.setData(previousDetail);
      documents.setData(previousDocuments);
      setError(errorMessage(failure));
    } finally {
      setPending("");
    }
  }

  return (
    <Popover label="대표 문서 지정" onClose={onClose}>
      {error && (
        <div className="app-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <State
        resource={documents}
        isEmpty={!documents.loading && !documents.error && rows.length === 0}
        empty="승인할 수 있는 적용 건이 없습니다 — 문서를 검수해 매핑을 모두 승인한 뒤 다시 시도하세요."
      />
      {rows.length > 0 && (
        <div className="app-list" aria-label="승인 가능한 적용 건">
          {rows.map((row) => (
            <div className="app-list-item" key={row.application_id}>
              <span>
                <strong>{row.document_name}</strong>
                <small>
                  {snapshotLabel(row.snapshot, { history: true })} · {compatibilityLabel(row.compatibility)} · 검수 {row.heads_approved}/{row.heads_total}
                </small>
              </span>
              <button type="button" className="small primary" disabled={pending === row.application_id || profile.status === "deprecated"} onClick={() => approve(row)}>
                이 문서로 승인
              </button>
            </div>
          ))}
        </div>
      )}
    </Popover>
  );
}

type DocumentChoice = { snapshot_id: string; document_name: string; document_id: string };

// 저장된 현재 리비전을 고른 문서에 적용해 본다(?test=<profile_id>&snapshot=<sid> → Source Review 테스트 모드).
function TestPopover({ profileId, documents, onClose }: { profileId: string; documents: PageResource<ProfileDocumentRow>; onClose: () => void }) {
  const { go } = useNavigation();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const applied: DocumentChoice[] = documents.items.map((r) => ({ snapshot_id: r.snapshot.snapshot_id, document_name: r.document_name, document_id: r.document_id }));
  // 적용 문서가 없으면 문서 목록 첫 페이지를 후보로 쓴다(검색하면 그 결과로 바뀐다).
  const noneApplied = !documents.loading && !documents.error && applied.length === 0;
  const search = usePage<DocumentRow>(q ? withQuery("/documents", { q }) : noneApplied ? "/documents" : null);
  const [choice, setChoice] = useState<DocumentChoice | null>(null);
  const found: DocumentChoice[] = (q || noneApplied
    ? search.items.filter((d) => d.current_snapshot && !applied.some((a) => a.document_id === d.document_id))
    : []
  ).map((d) => ({ snapshot_id: d.current_snapshot!.snapshot_id, document_name: d.document_name, document_id: d.document_id }));
  const empty = noneApplied && !q && !search.loading && !search.error && found.length === 0;
  const option = (doc: DocumentChoice, hint: string) => (
    <label className="app-check app-list-item" key={doc.document_id}>
      <input type="radio" name="test-document" aria-label={doc.document_name} checked={choice?.document_id === doc.document_id} onChange={() => setChoice(doc)} />
      <span>
        <strong>{doc.document_name}</strong>
        <small>{hint}</small>
      </span>
    </label>
  );
  return (
    <Popover label="테스트 문서 고르기" align="right" onClose={onClose}>
      <p className="app-muted app-small">문서를 고르면 저장된 현재 리비전을 적용한 결과를 Source Review에서 확인합니다(저장하지 않습니다).</p>
      <div className="app-toolbar">
        <label className="app-grow">
          문서 검색
          <input placeholder="다른 문서를 찾으려면 문서명 입력" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button
          type="button"
          className="primary"
          disabled={!choice}
          onClick={() => {
            if (!choice) return;
            onClose();
            go({ test: profileId, snapshot: choice.snapshot_id, review: "", rule: "", range: "", sheet: "" });
          }}
        >
          테스트 실행
        </button>
      </div>
      {empty && <p className="app-empty">테스트할 문서가 없습니다. 먼저 문서를 등록하세요.</p>}
      {applied.length > 0 && (
        <div className="app-list" role="radiogroup" aria-label="적용 문서">
          {applied.map((doc) => option(doc, "이 프로파일이 적용된 문서"))}
        </div>
      )}
      {found.length > 0 && (
        <div className="app-list" role="radiogroup" aria-label={q ? "검색 결과" : "등록된 문서"}>
          {found.map((doc) => option(doc, q ? "검색된 문서" : "등록된 문서"))}
        </div>
      )}
      {q && <State resource={search} empty="조건에 맞는 문서가 없습니다." isEmpty={!search.loading && !search.error && found.length === 0} />}
    </Popover>
  );
}

// 현재 리비전 정의를 파일로 내려받는다(GET /profiles/{id}/export).
function ExportButton({ base, profile }: { base: string; profile: ProfileDetailData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button
        type="button"
        className="small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await downloadFile(base + "/export", `${profile.profile_name}_v${profile.current_rev}.json`);
          } catch (failure) {
            setError(errorMessage(failure));
          } finally {
            setBusy(false);
          }
        }}
      >
        내보내기
      </button>
      {error && (
        <span className="app-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 정의 JSON 편집기

function DefinitionEditor({
  profile,
  definition,
  viewingRev,
  onSave,
  onDirty,
}: {
  profile: ProfileDetailData;
  definition: Resource<ProfileDefinition>;
  viewingRev: string;
  onSave: (next: ProfileDefinition) => Promise<boolean>;
  onDirty: (dirty: boolean) => void;
}) {
  const { go } = useNavigation();
  const [text, setText] = useState("");
  // 편집기를 채운 기준 텍스트. `loaded`와 따로 두는 이유: 정의가 도착한 렌더와 편집기에 반영되는 렌더 사이에
  // `text !== loaded`인 한 순간이 있고, 그 한 순간을 '저장 안 한 편집'으로 보면 재파싱이 헛되이 되묻는다.
  const [baseText, setBaseText] = useState("");
  const [preview, setPreview] = useState<ProfileImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loaded = definition.data ? pretty(definition.data) : "";
  useEffect(() => {
    // 다시 읽는 동안 loaded가 잠깐 ""로 떨어진다(useData가 새로 읽기 시작할 때). 그때 편집기를 비우면
    // 저장하지 않은 편집이 경고 없이 사라진다 — 빈 값으로 가는 전이는 무시하고 실제 값이 올 때만 채운다.
    if (!loaded) return;
    setText(loaded);
    setBaseText(loaded);
    setPreview(null);
  }, [loaded]);
  const parsed = useMemo(() => parseDefinition(text), [text]);
  const dirty = !!baseText && text !== baseText;
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  const readOnly = !!viewingRev;
  const debounced = useDebounced(text, 400);
  // 입력 즉시 JSON 구문 검사, 400ms 뒤 검증(오류·경고)을 자동으로 받아 온다(§7 — 따로 누를 '검증' 버튼은 없다).
  useEffect(() => {
    const { definition: parsedDefinition } = parseDefinition(debounced);
    if (readOnly || !parsedDefinition) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setChecking(true);
    setError("");
    api<ProfileImportPreview>("/profiles/import-preview", { schema_key: profile.schema.key, definition: parsedDefinition })
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((failure) => {
        if (!cancelled) {
          setPreview(null);
          setError(errorMessage(failure));
        }
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, profile.schema.key, readOnly]);
  const errors: Problem[] = (preview?.errors as Problem[] | undefined) || [];
  const warnings: Problem[] = (preview?.warnings as Problem[] | undefined) || [];

  async function save() {
    if (!parsed.definition) return;
    setSaving(true);
    await onSave(parsed.definition);
    setSaving(false);
  }

  return (
    <div className="app-stack">
      <h3>정의 JSON</h3>
      {readOnly && (
        <p className="app-note" role="status">
          리비전 v{viewingRev}을(를) 읽기 전용으로 보고 있습니다.{" "}
          <button type="button" className="link small" onClick={() => go({ rev: "" })}>
            현재 리비전(v{profile.current_rev})으로 돌아가기
          </button>
        </p>
      )}
      <State resource={definition} />
      {/* 다시 읽는 동안에도 편집기를 언마운트하지 않는다 — 언마운트하면 편집 중인 text가 사라진다. */}
      {(definition.data || text) && (
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
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {parsed.error ? (
            <div className="app-error" role="alert">
              <span>{parsed.error}</span>
            </div>
          ) : (
            <p className="app-muted app-small" role="status">
              {dirty ? "저장되지 않은 변경이 있습니다." : `현재 리비전 v${viewingRev || profile.current_rev}과 같습니다.`}
              {checking ? " · 검증하는 중…" : ""}
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
            <button type="button" className="primary" disabled={!parsed.definition || readOnly || saving || errors.length > 0} onClick={save}>
              저장(새 리비전)
            </button>
            <button type="button" disabled={!dirty || saving} onClick={() => setText(baseText)}>
              되돌리기
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 변경 이력

function History({ base, currentRev }: { base: string; currentRev: number }) {
  const { go } = useNavigation();
  const revisions = usePage<RevisionRow>(base + "/revisions");
  return (
    <div className="app-stack">
      <h3>변경 이력</h3>
      <State resource={revisions} empty="변경 이력이 없습니다." />
      {revisions.items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="변경 이력">
            <thead>
              <tr>
                <th scope="col">리비전</th>
                <th scope="col">시각</th>
                <th scope="col">규칙</th>
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
                  <td>규칙 {row.rule_count ?? 0}개</td>
                  <td>
                    <button type="button" className="small" onClick={() => go({ rev: row.rev === currentRev ? "" : String(row.rev) })}>
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
