// Source Review 우측 패널(검수 모드): 필드·규칙·관찰된 키·추출값·원본 위치·상태, 수정(인라인 편집기) · 승인 · 반려,
// 접힌 상세(선택자 JSON, 변경 이력은 펼칠 때만 GET /mappings/{mid}/revisions, 복원).
import { useState } from "react";
import { Pager, State, mappingRevisionLabel, regionLabel, useData, usePage, useWriteSeq } from "./client";
import type { MappingRegion, MappingRevisionRow, MappingRow, MappingStatus, SchemaTree } from "./types";
import { Chip } from "./ui";
import {
  flattenFields,
  formatValue,
  mappingStatusClass,
  mappingStatusLabel,
  mergeRegions,
  originLabel,
  roleLabel,
} from "./sourceReviewShared";

export type PanelMessage = { kind: "error" | "info"; text: string } | null;

export type MappingPanelProps = {
  mapping: MappingRow;
  schemaKey: string;
  // 드래그로 다시 지정한 원본 위치(다음 리비전에 반영).
  pending: MappingRegion[];
  onRemovePending: (role: string) => void;
  busy: boolean;
  message: PanelMessage;
  // 새 리비전 저장(승인·반려·수정). 실패 처리는 호출자가 한다.
  onSubmit: (status: MappingStatus, extra?: { field_key?: string; reason?: string }) => Promise<boolean>;
  onRollback: (revision: MappingRevisionRow) => Promise<boolean>;
  onShowRegion: (region: MappingRegion) => void;
};

export default function MappingPanel({ mapping, schemaKey, pending, onRemovePending, busy, message, onSubmit, onRollback, onShowRegion }: MappingPanelProps) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const regions = mergeRegions(mapping.regions, pending);
  const changed = pending.length > 0;

  async function approve() {
    if (await onSubmit("approved")) setRejecting(false);
  }
  async function reject() {
    if (!rejecting) {
      setRejecting(true);
      return;
    }
    if (await onSubmit("rejected", reason ? { reason } : undefined)) {
      setRejecting(false);
      setReason("");
    }
  }

  return (
    <div className="app-stack" data-testid="mapping-panel" data-mapping-status={mapping.status || "none"}>
      <div className="app-inline">
        <h3 style={{ margin: 0 }}>{mapping.rule_name}</h3>
        <Chip kind={mappingStatusClass(mapping.status)}>{mappingStatusLabel(mapping.status)}</Chip>
        {changed && <Chip kind="blue">원본 위치 변경됨</Chip>}
      </div>
      <dl className="app-kv">
        <dt>필드</dt>
        <dd>
          {mapping.field ? (
            <>
              <strong>{mapping.field.name}</strong>
              {mapping.field.type || mapping.field.unit ? (
                <span className="app-muted app-small">
                  {" "}
                  {[mapping.field.type, mapping.field.unit].filter(Boolean).join(" · ")}
                </span>
              ) : null}
            </>
          ) : (
            <span className="app-muted">미지정 — 승인하려면 필드를 고르세요</span>
          )}
        </dd>
        <dt>파싱 규칙</dt>
        <dd>{mapping.rule_name}</dd>
        <dt>관찰된 키</dt>
        <dd>{mapping.observed_key || "-"}</dd>
        <dt>추출값</dt>
        <dd>
          {mapping.value ? (
            <>
              <strong>{formatValue(mapping.value)}</strong>
              {mapping.value.count > 1 && <span className="app-muted app-small"> · 값 {mapping.value.count}개 중 첫 값</span>}
              {mapping.value.first_region && (
                <span className="app-muted app-small"> · {regionLabel(mapping.value.first_region.sheet_name, mapping.value.first_region.range)}</span>
              )}
            </>
          ) : (
            <span className="app-muted">없음 (승인 후 추출)</span>
          )}
        </dd>
        <dt>원본 위치</dt>
        <dd>
          {regions.length ? (
            <ul className="app-region-list">
              {regions.map((region) => {
                const isPending = pending.includes(region);
                return (
                  <li key={region.role + region.sheet_id + region.range}>
                    <button type="button" className="link" onClick={() => onShowRegion(region)} title="시트에서 보기">
                      {roleLabel(region.role)}: {regionLabel(region.sheet_name, region.range)}
                    </button>
                    {isPending && (
                      <>
                        <Chip kind="blue">새 위치</Chip>
                        <button type="button" className="link small" aria-label={`${roleLabel(region.role)} 재지정 취소`} onClick={() => onRemovePending(region.role)}>
                          취소
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            "-"
          )}
        </dd>
        <dt>상태</dt>
        <dd>
          {mappingStatusLabel(mapping.status)}
          <span className="app-muted app-small"> · {originLabel(mapping.origin)} · #{mapping.revision_no}</span>
        </dd>
      </dl>

      {message && (
        <div className={message.kind === "error" ? "app-error" : "app-note"} role={message.kind === "error" ? "alert" : "status"}>
          <span>{message.text}</span>
        </div>
      )}

      {editing ? (
        <MappingEditor
          mapping={mapping}
          schemaKey={schemaKey}
          busy={busy}
          changed={changed}
          onCancel={() => setEditing(false)}
          onSave={async (status, extra) => {
            if (await onSubmit(status, extra)) setEditing(false);
          }}
        />
      ) : (
        <div className="app-stack">
          {rejecting && (
            <label className="app-stack app-small">
              반려 사유
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="선택 입력" />
            </label>
          )}
          <div className="app-inline" role="group" aria-label="검수 행동">
            <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(true)}>
              수정
            </button>
            <button type="button" className="primary" disabled={busy || (mapping.status === "approved" && !changed)} onClick={approve}>
              승인
            </button>
            <button type="button" className="danger" disabled={busy || mapping.status === "rejected"} onClick={reject}>
              {rejecting ? "반려 확정" : "반려"}
            </button>
            {rejecting && (
              <button type="button" className="link" onClick={() => setRejecting(false)}>
                취소
              </button>
            )}
          </div>
        </div>
      )}

      <details className="app-details">
        <summary>선택자 JSON</summary>
        <pre className="app-json">{JSON.stringify(mapping.effective_spec ?? {}, null, 2)}</pre>
      </details>
      <RevisionHistory mapping={mapping} busy={busy} onRollback={onRollback} />
    </div>
  );
}

function MappingEditor({
  mapping,
  schemaKey,
  busy,
  changed,
  onCancel,
  onSave,
}: {
  mapping: MappingRow;
  schemaKey: string;
  busy: boolean;
  changed: boolean;
  onCancel: () => void;
  onSave: (status: MappingStatus, extra: { field_key?: string; reason?: string }) => Promise<void>;
}) {
  // 필드 목록은 트리 응답 1회(편집기를 열 때만).
  const tree = useData<SchemaTree>(schemaKey ? "/schemas/" + encodeURIComponent(schemaKey) + "/tree" : null);
  const fields = flattenFields(tree.data?.nodes);
  const [fieldKey, setFieldKey] = useState(mapping.field?.key || "");
  const [status, setStatus] = useState<MappingStatus>(mapping.status === "approved" ? "approved" : "proposed");
  const [reason, setReason] = useState("");
  const fieldChanged = fieldKey !== (mapping.field?.key || "");
  const dirty = fieldChanged || changed || status !== mapping.status;
  return (
    <form
      className="app-form app-stack"
      aria-label="매핑 수정"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(status, { ...(fieldChanged || !mapping.field ? { field_key: fieldKey } : {}), ...(reason ? { reason } : {}) });
      }}
    >
      <label className="app-stack app-small">
        필드
        <select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} disabled={tree.loading}>
          <option value="">{tree.loading ? "필드를 불러오는 중…" : "필드 선택"}</option>
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {(field.group ? field.group + " › " : "") + field.name}
              {field.unit ? ` (${field.unit})` : field.type ? ` (${field.type})` : ""}
            </option>
          ))}
          {mapping.field && !fields.some((f) => f.key === mapping.field!.key) && (
            <option value={mapping.field.key}>{mapping.field.name}</option>
          )}
        </select>
      </label>
      {tree.error && (
        <div className="app-error" role="alert">
          <span>{tree.error.message}</span>
          <button type="button" className="small" onClick={tree.reload}>
            다시 시도
          </button>
        </div>
      )}
      <p className="app-note app-small">원본 위치를 바꾸려면 시트에서 역할(키·값·단위·문맥)을 고른 뒤 드래그하세요.</p>
      <label className="app-stack app-small">
        저장 상태
        <select value={status} onChange={(e) => setStatus(e.target.value as MappingStatus)}>
          <option value="proposed">제안 (검수 대기)</option>
          <option value="approved">승인 (추출까지)</option>
        </select>
      </label>
      <label className="app-stack app-small">
        사유
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="선택 입력" />
      </label>
      <div className="app-inline">
        <button type="submit" className="primary" disabled={busy || !dirty || (status === "approved" && !fieldKey)}>
          저장
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </div>
    </form>
  );
}

function RevisionHistory({ mapping, busy, onRollback }: { mapping: MappingRow; busy: boolean; onRollback: (revision: MappingRevisionRow) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="app-details" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>변경 이력</summary>
      {open && <RevisionList mapping={mapping} busy={busy} onRollback={onRollback} />}
    </details>
  );
}

function RevisionList({ mapping, busy, onRollback }: { mapping: MappingRow; busy: boolean; onRollback: (revision: MappingRevisionRow) => Promise<boolean> }) {
  // 쓰기(승인·반려·복원)가 서버에 저장된 뒤(writeSeq 증가) 다시 읽는다. revision_no는 낙관적 갱신으로 POST보다 먼저 오르므로
  // 그 값으로 다시 읽으면 아직 저장되기 전 목록이 캐시에 남는다.
  const writeSeq = useWriteSeq();
  const revisions = usePage<MappingRevisionRow>("/mappings/" + encodeURIComponent(mapping.mapping_id) + "/revisions", writeSeq);
  return (
    <div className="app-stack">
      <State resource={revisions} empty="아직 리비전이 없습니다." />
      {revisions.items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="변경 이력">
            <thead>
              <tr>
                <th scope="col">리비전</th>
                <th scope="col">상태</th>
                <th scope="col">필드</th>
                <th scope="col">출처</th>
                <th scope="col">사유</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {revisions.items.map((revision) => {
                const isHead = revision.revision_no === mapping.revision_no;
                return (
                  <tr key={revision.mapping_revision_id}>
                    <td>
                      {mappingRevisionLabel(revision)}
                      {isHead && (
                        <>
                          {" "}
                          <Chip kind="blue">현재</Chip>
                        </>
                      )}
                    </td>
                    <td>
                      <Chip kind={mappingStatusClass(revision.status)}>{mappingStatusLabel(revision.status)}</Chip>
                    </td>
                    <td>{revision.field?.name || "-"}</td>
                    <td>{originLabel(revision.origin)}</td>
                    <td className="app-wrap">{revision.reason || "-"}</td>
                    <td>
                      {!isHead && (
                        <button type="button" className="small" disabled={busy} onClick={() => void onRollback(revision)}>
                          복원
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={revisions} />
    </div>
  );
}
