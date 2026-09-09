import { useEffect, useState } from "react";
import { api, useData } from "./client";
import type { Row } from "./client";

const REASONS: Row = {
  review_required: "검수 필요",
  published: "이미 발행됨",
  stale_version: "이전 문서 버전",
  in_progress: "추출 진행 중",
  queue_full: "대기열 가득 참",
};

export default function Recrawl({
  templateVersionId,
}: {
  templateVersionId: string;
}) {
  const [mode, setMode] = useState<"fill" | "reset_auto">("fill");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Row | null>(null);
  const id = encodeURIComponent(templateVersionId);
  const status = useData(
    result?.queued?.length
      ? `/template-versions/${id}/recrawl-status?request_key=${encodeURIComponent(result.request_key)}`
      : null,
  );
  useEffect(() => {
    // 대기/실행 중 작업이 남아 있으면 1초 뒤 다시 조회한다. 조회가 실패하면 3초 뒤 다시 시도한다.
    const s = status.data?.summary || {};
    if (status.error) {
      const t = setTimeout(status.reload, 3000);
      return () => clearTimeout(t);
    }
    if (!status.data || !((s.queued || 0) + (s.running || 0))) return;
    const t = setTimeout(status.reload, 1000);
    return () => clearTimeout(t);
  }, [status.data, status.error]);
  async function run() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      setResult(
        await api(`/template-versions/${id}/recrawl`, {
          mode,
          request_key: crypto.randomUUID(),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const s = status.data?.summary || {};
  return (
    <fieldset className="v2-recrawl">
      <legend>템플릿 재크롤링</legend>
      <p className="v2-note">
        현재 문서 버전에 이 템플릿 버전을 적용한 건을 승인된 규칙으로 다시
        추출합니다. 검수가 끝나지 않은 적용 건은 건너뛰며 매핑 리비전은 바꾸지
        않습니다.
      </p>
      <label>
        실행 방식
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as "fill" | "reset_auto")}
        >
          <option value="fill">채우기 · 발행 결과가 없는 적용 건만</option>
          <option value="reset_auto">자동 재추출 · 승인된 적용 건 모두</option>
        </select>
      </label>
      <button className="primary" disabled={busy} onClick={run}>
        실행
      </button>
      <p className="v2-error" role="alert">
        {error || (status.error ? "진행 상태 조회 실패: " + status.error + " (다시 시도 중)" : "")}
      </p>
      {result && (
        <div role="status">
          <strong>
            대기열 {result.queued.length}건 · 건너뜀 {result.skipped.length}건
          </strong>
          {result.truncated && (
            <span className="v2-muted">
              {" "}
              · 상한 {result.population_limit}건까지만 처리했습니다. 실행을 다시 눌러 이어서 처리하세요.
            </span>
          )}
          {status.data && (
            <span className="v2-muted">
              {" "}
              · 완료 {s.succeeded || 0} · 실패{" "}
              {(s.failed || 0) + (s.cancelled || 0)} · 진행{" "}
              {(s.queued || 0) + (s.running || 0)}
            </span>
          )}
          <ul>
            {result.queued.map((q: Row) => (
              <li key={q.application_id}>
                <code>{q.application_id}</code> 대기열 등록
              </li>
            ))}
            {result.skipped.map((k: Row) => (
              <li key={k.application_id}>
                <code>{k.application_id}</code> 건너뜀 ·{" "}
                {REASONS[k.reason] || k.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}
