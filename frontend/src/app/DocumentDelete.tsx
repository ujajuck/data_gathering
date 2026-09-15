// 문서 삭제 확인 대화상자(§4.13 · §7). 단건(상세 드로어)과 다중(목록 선택 바)이 같은 대화상자·같은 문구를 쓴다.
// - 단건: DELETE /documents/{id}?purge_source= (동기, 200 본문이 결과)
// - 다중: POST /documents/delete?wait=10 {document_ids, purge_source} (작업; 10초를 넘기면 닫아도 JobBar에서 이어진다)
// 되돌릴 수 없는 일이므로 지울 문서를 이름으로 보여 주고(최대 10개), 원본 파일 삭제는 기본 해제 체크박스다.
// 결과는 토스트로 요약하고, 실패(문서 삭제 실패·원본 삭제 실패)가 있으면 무엇이 실패했는지 보이려고 대화상자를 열어 둔다.
import { useState } from "react";
import { api, isJobActive, useNavigation, useToast, withQuery } from "./client";
import type { DocumentDeleteResult, JobResponse } from "./types";
import { deleteSummaryLines } from "./types";
import DeleteDialog from "./DeleteDialog";

// reference_profiles: 이 문서를 대표 문서로 삼은 파싱 프로파일 이름(§4.13 — 지우면 그 프로파일이 초안으로 내려간다).
export type DeleteTarget = { document_id: string; document_name: string; reference_profiles?: string[] };

// 처음에 몇 개까지 펼쳐 보일지(§7). 넘으면 `외 <N>개`와 함께 전체 목록을 펼쳐 볼 수 있다.
export const NAME_LIMIT = 10;

// 대표 문서를 지우면 자동 적용이 멈춘다 — 확인하기 전에 알린다(끝난 뒤의 토스트로 처음 알게 해서는 안 된다).
export function referenceWarning(targets: DeleteTarget[]): string {
  const names = [...new Set(targets.flatMap((t) => t.reference_profiles ?? []))];
  if (!names.length) return "";
  const shown = names.slice(0, 3).map((n) => `'${n}'`).join(", ");
  const rest = names.length - Math.min(names.length, 3);
  return (
    `대표 문서입니다 — 파싱 프로파일 ${shown}${rest ? ` 외 ${rest}개` : ""}이(가) 초안으로 내려가 ` +
    `새 문서에 자동 적용되지 않습니다. 대표 문서를 다시 지정해 승인해야 합니다.`
  );
}

export function deleteConfirmMessage(targets: DeleteTarget[]): string {
  return targets.length === 1
    ? `'${targets[0].document_name}'을(를) 지웁니다. 이 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.`
    : `문서 ${targets.length}개를 지웁니다. 각 문서의 snapshot·적용 건·매핑·추출값이 함께 사라지고 되돌릴 수 없습니다.`;
}

export default function DocumentDelete({
  targets,
  onClose,
  onDeleted,
}: {
  targets: DeleteTarget[];
  onClose: () => void;
  // 한 건이라도 지워졌으면 부른다(목록·선택·드로어를 비우고 다시 읽는다). 작업이 진행 중이면 result는 null이다.
  onDeleted: (result: DocumentDeleteResult | null) => void;
}) {
  const { notify } = useToast();
  const { go } = useNavigation();
  const [purge, setPurge] = useState(false);
  const [result, setResult] = useState<DocumentDeleteResult | null>(null);
  // 아직 지우지 못한 문서. 부분 실패 뒤 다시 누르면 이미 지운 문서를 또 보내지 않는다.
  const [pending, setPending] = useState<DeleteTarget[]>(targets);
  const asking = pending.length ? pending : targets;
  const single = asking.length === 1;
  const shown = asking.slice(0, NAME_LIMIT);
  const rest = asking.length - shown.length;
  const failedRows = (result?.documents ?? []).filter((d) => d.error);
  const sourceFailedRows = (result?.documents ?? []).filter((d) => !d.source_removed && d.source_error);
  const renderFailedRows = (result?.documents ?? []).filter((d) => d.render_error);
  const warning = referenceWarning(asking);

  async function run() {
    const ids = pending.map((t) => t.document_id);
    let body: DocumentDeleteResult;
    if (single) {
      body = await api<DocumentDeleteResult>(
        withQuery("/documents/" + encodeURIComponent(ids[0]), { purge_source: String(purge) }),
        undefined,
        { method: "DELETE" },
      );
    } else {
      const job = await api<JobResponse>(withQuery("/documents/delete", { wait: 10 }), { document_ids: ids, purge_source: purge });
      if (isJobActive(job)) {
        // 10초를 넘겼다 — 작업은 계속 돈다. 결과는 JobBar·작업 내역에서 이어서 본다.
        notify("문서 삭제가 작업 내역에서 계속 진행됩니다.");
        onDeleted(null);
        onClose();
        return;
      }
      if (job.state !== "succeeded") throw new Error(job.error_message || "문서를 지우지 못했습니다.");
      body = (job.result || { documents: [], profiles_reset: [], summary: { requested: ids.length, deleted: 0, failed: 0 } }) as unknown as DocumentDeleteResult;
    }
    setResult(body);
    const stillFailing = new Set((body.documents ?? []).filter((d) => d.error).map((d) => d.document_id));
    setPending(pending.filter((t) => stillFailing.has(t.document_id)));
    // 대표 문서를 지워 초안으로 내려간 프로파일이 있으면 그 목록으로 가는 길을 함께 준다(§7).
    notify(
      deleteSummaryLines(body).join(" "),
      body.profiles_reset?.length
        ? { label: "파싱 프로파일 열기", onClick: () => go({ screen: "profiles", profile: "", document: "", tab: "", sheet: "" }) }
        : undefined,
    );
    if (body.summary?.deleted) onDeleted(body);
    // 무엇이 실패했는지(문서·원본 파일·렌더 캐시) 보여야 하므로 그때만 대화상자를 열어 둔다.
    const stay =
      (body.summary?.failed ?? 0) > 0 || body.documents?.some((d) => (!d.source_removed && d.source_error) || d.render_error);
    if (!stay) onClose();
  }

  return (
    <DeleteDialog
      label="문서 삭제"
      message={deleteConfirmMessage(asking)}
      busyLabel="지우는 중…"
      confirmDisabled={pending.length === 0}
      // 이미 지운 뒤 결과를 보고 있으면 남은 버튼은 `취소`가 아니라 `닫기`다(지운 것을 되돌릴 수 있다는 인상을 주지 않는다).
      cancelLabel={result ? "닫기" : "취소"}
      onCancel={onClose}
      onConfirm={run}
    >
      {/* 확인하기 전에 보여야 하는 부작용이다(끝난 뒤의 토스트로 처음 알게 해서는 안 된다). */}
      {warning && <p className="app-error">{warning}</p>}
      {!single && (
        <>
          <ul className="app-plain-list" aria-label="지울 문서">
            {shown.map((t) => (
              <li key={t.document_id}>{t.document_name}</li>
            ))}
            {rest > 0 && <li className="app-muted">외 {rest}개</li>}
          </ul>
          {/* 되돌릴 수 없는 삭제라 대상 전체를 확인할 길을 둔다 — 200건도 이름으로 볼 수 있어야 한다. */}
          {rest > 0 && (
            <details>
              <summary>지울 문서 {asking.length}개 모두 보기</summary>
              <ul className="app-plain-list app-scroll-list" aria-label="지울 문서 전체">
                {asking.map((t) => (
                  <li key={t.document_id}>{t.document_name}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <label className="app-check">
        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
        <span>원본 파일도 함께 지우기 (data/raw)</span>
      </label>
      <p className="app-muted app-small">체크하지 않으면 원본 파일은 그대로 남고, 다시 등록하면 같은 문서가 만들어집니다.</p>
      {result && (
        <div className="app-stack" role="status" aria-label="삭제 결과">
          {deleteSummaryLines(result).map((line) => (
            <p key={line} className="app-small">
              {line}
            </p>
          ))}
          {failedRows.length > 0 && (
            <ul className="app-plain-list" aria-label="지우지 못한 문서">
              {failedRows.map((d) => (
                <li key={d.document_id}>
                  <strong>{d.document_name || "이름을 알 수 없는 문서"}</strong>
                  <span className="app-muted app-small"> · {d.error?.message}</span>
                </li>
              ))}
            </ul>
          )}
          {sourceFailedRows.length > 0 && (
            <ul className="app-plain-list" aria-label="지우지 못한 원본 파일">
              {sourceFailedRows.map((d) => (
                <li key={d.document_id}>
                  <strong>{d.source_ref || d.document_name || "원본 파일"}</strong>
                  <span className="app-muted app-small"> · {d.source_error?.message}</span>
                </li>
              ))}
            </ul>
          )}
          {renderFailedRows.length > 0 && (
            <ul className="app-plain-list" aria-label="렌더 캐시를 지우지 못한 문서">
              {renderFailedRows.map((d) => (
                <li key={d.document_id}>
                  <strong>{d.document_name || d.source_ref || "문서"}</strong>
                  <span className="app-muted app-small"> · 렌더 캐시를 지우지 못했습니다 — {d.render_error?.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </DeleteDialog>
  );
}
