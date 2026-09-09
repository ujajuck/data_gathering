import { useState } from "react";
import { api, State, useData, useNavigation, usePage } from "./client";
import type { Row } from "./client";

const pct = (value: number | null | undefined) =>
  value == null ? null : Math.round(value * 100);

// 서버가 시트명으로 맞춘 바인딩. 사용자가 바꾸지 않았으면 override를 보내지 않는다.
function automatic(suggestion: Row): Record<string, string[]> {
  const next: Record<string, string[]> = {};
  for (const m of suggestion.matched_sheets || [])
    (next[m.role] ||= [])[m.ordinal] = m.target_sheet_id || "";
  return next;
}

export default function Suggestions() {
  const { route, go, changed } = useNavigation();
  const suggestions = useData(
    route.version ? `/versions/${route.version}/suggestions?limit=10` : null,
  );
  const sheets = usePage(
    route.version ? `/versions/${route.version}/sheets` : null,
  );
  const [selected, setSelected] = useState("");
  const [bindings, setBindings] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const data = suggestions.data;
  const chosen = data?.items?.find(
    (s: Row) => s.source_application_id === selected,
  );
  function pick(suggestion: Row) {
    setSelected(suggestion.source_application_id);
    setBindings(automatic(suggestion));
    setError("");
  }
  async function register() {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const body: Row = { source_application_id: selected };
      if (
        chosen.unmatched_roles?.length ||
        JSON.stringify(bindings) !== JSON.stringify(automatic(chosen))
      )
        body.sheet_bindings = Object.fromEntries(
          Object.entries(bindings).map(([role, ids]) => [
            role,
            ids.filter(Boolean),
          ]),
        );
      const result = await api(
        `/versions/${route.version}/applications/from-suggestion`,
        body,
      );
      changed();
      go({
        tab: "source",
        application: result.application_id,
        mapping: "",
        series: "",
        item: "",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sign() {
    setBusy(true);
    setError("");
    try {
      await api(`/versions/${route.version}/signature`, {});
      suggestions.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="v2-suggestions">
      <h3>같은 양식으로 보이는 문서군</h3>
      <p className="v2-muted">
        이미 템플릿을 연결한 문서와 시트명·헤더·병합 구조를 비교합니다. 이식한
        규칙은 검수 대기이며 자동 승인되지 않습니다.
      </p>
      {data?.signature_status === "missing" ? (
        <>
          <p className="v2-note">
            이 버전의 구조 서명이 없어 비교할 수 없습니다.
          </p>
          <button disabled={busy} onClick={sign}>
            구조 서명 계산
          </button>
        </>
      ) : (
        <>
          <State
            resource={suggestions}
            empty="비슷한 양식의 문서군이 없습니다."
          />
          <div className="v2-list">
            {data?.items?.map((s: Row) => {
              const b = s.breakdown || {};
              const score = pct(s.score) ?? 0;
              return (
                <button
                  className={
                    "v2-list-item " +
                    (s.source_application_id === selected ? "selected" : "")
                  }
                  aria-pressed={s.source_application_id === selected}
                  key={s.source_application_id}
                  onClick={() => pick(s)}
                >
                  <span>
                    <strong>
                      {s.source_document_name} · v{s.source_revision_no}
                    </strong>
                    <span className="v2-suggestion-score">
                      <span
                        className="v2-score"
                        role="meter"
                        aria-label="유사도"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={score}
                      >
                        <span style={{ width: score + "%" }} />
                      </span>
                      <b>{score}%</b>
                    </span>
                    <small>
                      시트명 {pct(b.sheet_names?.score) ?? 0}% · 헤더{" "}
                      {pct(b.headers?.score) ?? 0}% · 병합{" "}
                      {b.merges ? pct(b.merges.score) + "%" : "해당 없음"} ·{" "}
                      {s.template_name} v{s.template_revision_no} · 승인 규칙{" "}
                      {s.approved_rules}/{s.total_rules}
                    </small>
                    <small>
                      {(s.matched_sheets || [])
                        .map(
                          (m: Row) =>
                            `${m.role}: ${m.source_sheet} → ${m.target_sheet || "미매칭"}`,
                        )
                        .join(" · ")}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
          {data?.unsigned_candidates > 0 && (
            <p className="v2-muted">
              서명이 없는 적용 문서 {data.unsigned_candidates}건은 비교에서
              제외했습니다. `python -m kg.v2 sign`으로 계산할 수 있습니다.
            </p>
          )}
        </>
      )}
      {chosen && (
        <div className="v2-binding-row">
          {(chosen.matched_sheets || []).map((m: Row) => (
            <span key={m.role + ":" + m.ordinal}>
              {m.role} 시트 · {m.source_sheet}{" "}
              <select
                aria-label={`${m.role} 시트`}
                value={bindings[m.role]?.[m.ordinal] || ""}
                onChange={(e) =>
                  setBindings((current) => {
                    const ids = [...(current[m.role] || [])];
                    ids[m.ordinal] = e.target.value;
                    return { ...current, [m.role]: ids };
                  })
                }
              >
                <option value="">시트 선택</option>
                {sheets.data?.items.map((sheet) => (
                  <option value={sheet.sheet_id} key={sheet.sheet_id}>
                    {sheet.name}
                  </option>
                ))}
              </select>
            </span>
          ))}
        </div>
      )}
      <button
        className="primary"
        disabled={!selected || busy}
        onClick={register}
      >
        선택한 문서군으로 등록 (검수 대기)
      </button>
      <p className="v2-error" role="alert">
        {error}
      </p>
    </div>
  );
}
