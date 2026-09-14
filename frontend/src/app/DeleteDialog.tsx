// 삭제 확인 대화상자(§7 스키마 삭제 · 필드 삭제 공용).
// 실패하면 모달을 열어 둔 채 서버 message를 그대로 보이고, 서버가 준 근거(detail)를 목록으로 덧붙인다.
// 다음 행동 버튼: SCHEMA_IN_USE·FIELD_IN_USE → `사용 프로파일 보기`, FIELD_HAS_CHILDREN → `하위 필드 보기`
// (모달을 닫고 호출자가 그 목록으로 보낸다). 세 경우 모두 아무것도 지우지 않는다.
import { useState } from "react";
import { ApiError, errorMessage } from "./client";
import type { ApiErrorDetail } from "./types";
import { Modal } from "./ui";

export const USAGE_CODES = ["SCHEMA_IN_USE", "FIELD_IN_USE"];
export const CHILDREN_CODE = "FIELD_HAS_CHILDREN";
// 같은 요청을 다시 보내도 결과가 달라지지 않는 거부 — 삭제 버튼을 비활성화해 같은 실패를 반복하지 않게 한다.
export const FINAL_CODES = [...USAGE_CODES, CHILDREN_CODE, "LAST_FIELD", "DEFINITION_LOCKED", "PROFILE_IN_USE"];

export function blockerButtonLabel(code: string): string {
  return code === CHILDREN_CODE ? "하위 필드 보기" : "사용 프로파일 보기";
}

export type Blocker = { code: string; message: string; detail?: ApiErrorDetail };

export default function DeleteDialog({
  label,
  message,
  busyLabel,
  onCancel,
  onConfirm,
  onShowBlocker,
}: {
  label: string;
  message: string;
  busyLabel: string;
  onCancel: () => void;
  // 성공하면 호출자가 대화상자를 닫는다. 실패는 여기서 잡아 모달을 열어 둔 채 보여 준다.
  onConfirm: () => Promise<void>;
  // 다음 행동 버튼: 호출자가 모달을 닫고 해당 목록으로 보낸다.
  onShowBlocker: (blocker: Blocker) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Blocker | null>(null);
  const blocked = !!failure && FINAL_CODES.includes(failure.code);
  // '사용 프로파일 보기'·'하위 필드 보기'로 갈 곳이 있는 거부만 다음 행동 버튼을 띄운다.
  const hasBlockerView = !!failure && (USAGE_CODES.includes(failure.code) || failure.code === CHILDREN_CODE);

  async function confirm() {
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm();
    } catch (error) {
      const api = error instanceof ApiError ? error : null;
      setFailure({ code: api?.code || "", message: errorMessage(error), detail: api?.detail });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label={label}
      title={label}
      className="narrow"
      onClose={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="danger" disabled={busy || blocked} onClick={confirm}>
            삭제
          </button>
        </>
      }
    >
      <div className="app-stack">
        <p>{message}</p>
        {busy && (
          <p className="app-muted app-small" role="status">
            {busyLabel}
          </p>
        )}
        {failure && (
          <div className="app-error" role="alert">
            <span>{failure.message}</span>
            {hasBlockerView && (
              <button type="button" className="small" onClick={() => onShowBlocker(failure)}>
                {blockerButtonLabel(failure.code)}
              </button>
            )}
          </div>
        )}
        {failure?.detail?.profiles?.length ? (
          <ul className="app-plain-list" aria-label="사용 프로파일">
            {failure.detail.profiles.map((p) => (
              <li key={p.profile_id}>
                <strong>{p.profile_name}</strong>
                {p.current_rev !== undefined ? ` v${p.current_rev}` : ""}
                <span className="app-muted app-small">
                  {p.document_count !== undefined ? ` · 문서 ${p.document_count}개` : ""}
                  {p.rule_keys?.length ? ` · 규칙 ${p.rule_keys.join(", ")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {failure?.detail?.children?.length ? (
          <ul className="app-plain-list" aria-label="하위 필드">
            {failure.detail.children.map((c) => (
              <li key={c.field_key}>{c.name}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}
