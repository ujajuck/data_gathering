import { useState } from "react";
import { api, Pager, State, useData, useNavigation, usePage } from "./client";
import type { Row } from "./client";

export function ReviewQueue() {
  const { go, changed, refresh } = useNavigation();
  const [status, setStatus] = useState("proposed");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const list = usePage(
    `/review-queue?status=${status}&q=${encodeURIComponent(search)}&r=${refresh}`,
  );
  async function decide(row: Row, status: string) {
    setBusy(row.mapping_revision_id);
    setError("");
    try {
      const m = await api(`/mappings/${row.mapping_revision_id}`);
      await api(
        `/applications/${m.application_id}/mappings/${m.mapping_revision_id}/revisions`,
        {
          expected_seq: m.edit_seq,
          effective_spec: m.effective_spec,
          concept_id: m.concept_id,
          status,
          reason: "검수 큐에서 " + (status === "approved" ? "승인" : "반려"),
        },
      );
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="v2-card v2-space" aria-label="검수 큐">
      <h2>검수 큐</h2>
      <form
        className="v2-inline"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <input
          aria-label="검수 문서·규칙 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="문서명 · 규칙명"
        />
        <select
          aria-label="검수 상태"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="proposed">검수 대기</option>
          <option value="rejected">반려</option>
          <option value="approved">승인</option>
          <option value="all">전체</option>
        </select>
        <button>검색</button>
      </form>
      <State resource={list} empty="이 상태의 검수 규칙이 없습니다." />
      {list.data?.items.map((row) => (
        <div className="v2-list-item" key={row.mapping_revision_id}>
          <button
            className="v2-link"
            onClick={() =>
              go({
                tab: "source",
                document: row.document_id,
                version: row.document_version_id,
                application: row.application_id,
                mapping: row.mapping_revision_id,
                sheet: "",
                row: "",
                col: "",
                series: "",
                item: "",
              })
            }
          >
            {row.display_name} · {row.rule_key}{" "}
            <small>
              {row.template_name} · r{row.revision_no}
            </small>
          </button>
          <div className="v2-inline">
            <button disabled={!!busy} onClick={() => decide(row, "approved")}>
              승인
            </button>
            <button disabled={!!busy} onClick={() => decide(row, "rejected")}>
              반려
            </button>
          </div>
        </div>
      ))}
      <Pager page={list} />
      <p role="alert" className="v2-error">
        {error}
      </p>
    </section>
  );
}

export function RevisionHistory({ mapping }: { mapping: Row }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("이전 검수 규칙 복원");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { go, changed } = useNavigation();
  const history = usePage(
    open
      ? `/applications/${mapping.application_id}/rules/${encodeURIComponent(mapping.rule_key)}/revisions`
      : null,
  );
  const detail = useData(selected ? `/mappings/${selected}` : null);
  async function restore() {
    setBusy(true);
    setError("");
    try {
      // 과거 행을 덮어쓰지 않고 현재 리비전에 CAS를 적용하여 새 리비전으로 복원한다.
      const result = await api(
        `/applications/${mapping.application_id}/mappings/${mapping.mapping_revision_id}/rollback`,
        {
          expected_seq: mapping.edit_seq,
          target_revision_id: selected,
          reason,
        },
      );
      changed();
      go({ mapping: result.mapping_revision_id, series: "", item: "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="v2-details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>검수 이력 · 이전 버전 복원</summary>
      <State resource={history} />
      {history.data?.items.map((m) => (
        <button
          className="v2-list-item"
          key={m.mapping_revision_id}
          onClick={() => setSelected(m.mapping_revision_id)}
        >
          r{m.revision_no} · {m.status}{" "}
          <small>
            {m.reason} · {m.created_by}
          </small>
        </button>
      ))}
      <Pager page={history} />
      <State resource={detail} />
      {detail.data && (
        <>
          <pre className="v2-code">
            {JSON.stringify(detail.data.effective_spec, null, 2)}
          </pre>
          <label>
            복원 사유
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            disabled={
              busy || !reason.trim() || selected === mapping.mapping_revision_id
            }
            onClick={restore}
          >
            이 내용으로 새 검수 버전 만들기
          </button>
        </>
      )}
      <p role="alert" className="v2-error">
        {error}
      </p>
    </details>
  );
}
