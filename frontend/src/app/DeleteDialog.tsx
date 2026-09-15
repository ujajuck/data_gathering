// 되돌릴 수 없는 행동의 확인 대화상자(§7 스키마 삭제 · 필드 삭제 · 문서 삭제(§4.13) · 스키마 폐기(§4.2.3) 공용).
// 실패하면 모달을 열어 둔 채 서버 message를 그대로 보이고, 서버가 준 근거(detail)를 목록으로 덧붙인다.
// 다음 행동 버튼: SCHEMA_IN_USE·FIELD_IN_USE → `사용 프로파일 보기`, FIELD_HAS_CHILDREN → `하위 필드 보기`
// (모달을 닫고 호출자가 그 목록으로 보낸다). 세 경우 모두 아무것도 지우지 않는다.
import { useState } from "react";
import type { ReactNode } from "react";
import { ApiError, errorMessage } from "./client";
import type { ApiErrorDetail } from "./types";
import { Modal } from "./ui";

export const USAGE_CODES = ["SCHEMA_IN_USE", "FIELD_IN_USE"];
export const CHILDREN_CODE = "FIELD_HAS_CHILDREN";
// 같은 요청을 다시 보내도 결과가 달라지지 않는 거부 — 삭제 버튼을 비활성화해 같은 실패를 반복하지 않게 한다.
// DOCUMENT_BUSY(§4.13)는 여기 넣지 않는다: 돌고 있는 작업이 끝나면 같은 요청이 성공한다.
export const FINAL_CODES = [...USAGE_CODES, CHILDREN_CODE, "LAST_FIELD", "DEFINITION_LOCKED", "PROFILE_IN_USE", "TOO_MANY_DOCUMENTS"];

export function blockerButtonLabel(code: string): string {
  return code === CHILDREN_CODE ? "하위 필드 보기" : "사용 프로파일 보기";
}

export type Blocker = { code: string; message: string; detail?: ApiErrorDetail };

export default function DeleteDialog({
  label,
  message,
  busyLabel,
  confirmLabel = "삭제",
  confirmDisabled = false,
  confirmDanger = true,
  cancelLabel = "취소",
  onCancel,
  onConfirm,
  onShowBlocker,
  children,
}: {
  label: string;
  message: string;
  // 진행 중 주 행동 버튼에 보이는 문구.
  busyLabel: string;
  // 주 행동 버튼 문구(기본 `삭제`; 스키마 폐기는 `폐기`).
  confirmLabel?: string;
  // 더 할 일이 없을 때(부분 실패 뒤 남은 대상이 없을 때) 주 행동을 잠근다.
  confirmDisabled?: boolean;
  // 되돌릴 수 있는 행동(스키마 폐기 — '폐기 해제'가 있다)은 false로 두어 삭제와 시각적으로 구분한다.
  confirmDanger?: boolean;
  // 이미 끝난 일을 보고 있을 때는 `닫기`다 — 남은 유일한 나가기 버튼이 `취소`면 되돌릴 수 있다는 인상을 준다.
  cancelLabel?: string;
  onCancel: () => void;
  // 성공하면 호출자가 대화상자를 닫는다. 실패는 여기서 잡아 모달을 열어 둔 채 보여 준다.
  onConfirm: () => Promise<void>;
  // 다음 행동 버튼: 호출자가 모달을 닫고 해당 목록으로 보낸다.
  onShowBlocker?: (blocker: Blocker) => void;
  // 확인 문구 아래에 붙는 선택지·결과(문서 삭제의 `원본 파일도 함께 지우기` 체크박스와 결과 요약).
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Blocker | null>(null);
  const blocked = !!failure && FINAL_CODES.includes(failure.code);
  // '사용 프로파일 보기'·'하위 필드 보기'로 갈 곳이 있는 거부만 다음 행동 버튼을 띄운다.
  const hasBlockerView = !!failure && !!onShowBlocker && (USAGE_CODES.includes(failure.code) || failure.code === CHILDREN_CODE);

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
      // 진행 중에는 Escape·배경 클릭·×도 닫지 않는다 — '취소' 버튼을 잠근 것과 같은 뜻이어야 한다.
      dismissible={!busy}
      onClose={onCancel}
      actions={
        <>
          <button type="button" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" className={confirmDanger ? "danger" : "primary"} disabled={busy || blocked || confirmDisabled} onClick={confirm}>
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      <div className="app-stack">
        <p>{message}</p>
        {children}
        {failure && (
          <div className="app-error" role="alert">
            <span>{failure.message}</span>
            {hasBlockerView && (
              <button type="button" className="small" onClick={() => onShowBlocker!(failure)}>
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
