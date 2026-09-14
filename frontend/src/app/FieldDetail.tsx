// 파싱 스키마 > 필드 상세(§7 FieldDetail). 선택 시 GET /schemas/{key}/fields/{field_key} + 최근 값(…/values?limit=5) 2회.
// 필드명·영문명·설명·타입·단위·alias·상태·부모/자식/관련 링크·'사용 프로파일 N개 보기 ›'·'연관 문서 N개 보기 ›'·
// 'Source Review 열기'(최신 값의 application/rule/sheet/range; 값 없으면 비활성+힌트)·최근 값 목록(원본 보기)·편집(PATCH).
import { useState } from "react";
import type { FormEvent } from "react";
import { State, api, errorMessage, formatDateTime, regionLabel, relativeTime, reviewRoute, useData, useNavigation, withQuery } from "./client";
import type { FieldDetail as FieldDetailData, FieldValueRow, Page } from "./types";
import { Chip } from "./ui";

export const RECENT_VALUES = 5;

export function fieldStatusLabel(status: string | null | undefined): { label: string; kind: "ok" | "muted" | "warn" } {
  if (status === "deprecated") return { label: "폐기", kind: "muted" };
  if (status === "draft") return { label: "초안", kind: "warn" };
  return { label: "활성", kind: "ok" };
}

export type FieldPatch = { name?: string; description?: string; aliases?: string[]; status?: string };

// 편집 폼 값과 원본을 비교해 바뀐 항목만 PATCH 본문으로 만든다.
export function fieldPatch(original: FieldDetailData, form: { name: string; description: string; aliases: string; status: string }): FieldPatch {
  const patch: FieldPatch = {};
  const name = form.name.trim();
  if (name && name !== original.name) patch.name = name;
  const description = form.description.trim();
  if (description !== (original.description || "")) patch.description = description;
  const aliases = form.aliases
    .split(/[,\n]/)
    .map((a) => a.trim())
    .filter(Boolean);
  if (JSON.stringify(aliases) !== JSON.stringify(original.aliases || [])) patch.aliases = aliases;
  if (form.status !== original.status) patch.status = form.status;
  return patch;
}

export default function FieldDetail({
  schemaKey,
  fieldKey,
  names,
  onOpenTab,
  onSaved,
}: {
  schemaKey: string;
  fieldKey: string;
  // field_key → 이름(트리에서 얻은 것). 부모/자식/관련 링크 표시에 쓴다.
  names: Map<string, string>;
  onOpenTab: (tab: "profiles" | "documents", fieldKey: string) => void;
  onSaved: (field: FieldDetailData) => void;
}) {
  const { go } = useNavigation();
  const base = `/schemas/${encodeURIComponent(schemaKey)}/fields/${encodeURIComponent(fieldKey)}`;
  const field = useData<FieldDetailData>(base);
  const values = useData<Page<FieldValueRow>>(withQuery(base + "/values", { limit: RECENT_VALUES }));
  const [editing, setEditing] = useState(false);
  const data = field.data;
  const recent = values.data?.items ?? [];
  const newest = recent[0];
  const status = fieldStatusLabel(data?.status);
  const nameOf = (key: string) => names.get(key) || key;
  const openReview = (v: FieldValueRow) => go(reviewRoute({ application_id: v.application_id, rule_key: v.rule_key, sheet_id: v.sheet_id, range: v.range }));

  return (
    <section className="app-card" aria-label="필드 상세">
      <div className="app-card-head">
        <h3>필드 상세</h3>
        {data && !editing && (
          <button type="button" className="small" onClick={() => setEditing(true)}>
            편집
          </button>
        )}
      </div>
      <State resource={field} isEmpty={false} />
      {data && editing && (
        <FieldEditForm
          field={data}
          path={base}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            field.setData(next);
            setEditing(false);
            onSaved(next);
          }}
        />
      )}
      {data && !editing && (
        <div className="app-stack">
          <dl className="app-kv">
            <dt>필드명</dt>
            <dd>
              <strong>{data.name}</strong> <Chip kind={status.kind}>{status.label}</Chip>
            </dd>
            <dt>영문명</dt>
            <dd>
              <code>{data.field_key}</code>
            </dd>
            <dt>설명</dt>
            <dd>{data.description || <span className="app-muted">-</span>}</dd>
            <dt>타입</dt>
            <dd>{data.type || <span className="app-muted">-</span>}</dd>
            <dt>단위</dt>
            <dd>{data.unit || <span className="app-muted">-</span>}</dd>
            <dt>Alias</dt>
            <dd>
              {data.aliases?.length ? (
                <span className="app-chips" aria-label="Alias">
                  {data.aliases.map((a) => (
                    <Chip key={a} kind="blue">
                      {a}
                    </Chip>
                  ))}
                </span>
              ) : (
                <span className="app-muted">-</span>
              )}
            </dd>
          </dl>
          <h4>관계</h4>
          <dl className="app-kv" aria-label="필드 관계">
            <dt>부모</dt>
            <dd>
              <FieldLinks keys={data.parents} nameOf={nameOf} onSelect={(k) => go({ field_key: k })} />
            </dd>
            <dt>자식</dt>
            <dd>
              <FieldLinks keys={data.children} nameOf={nameOf} onSelect={(k) => go({ field_key: k })} />
            </dd>
            <dt>관련</dt>
            <dd>
              <FieldLinks keys={data.related} nameOf={nameOf} onSelect={(k) => go({ field_key: k })} />
            </dd>
          </dl>
          <h4>연결</h4>
          <dl className="app-kv">
            <dt>사용 프로파일</dt>
            <dd>
              <button type="button" className="link" onClick={() => onOpenTab("profiles", data.field_key)}>
                {data.profile_count}개 보기 ›
              </button>
            </dd>
            <dt>연관 문서</dt>
            <dd>
              <button type="button" className="link" onClick={() => onOpenTab("documents", data.field_key)}>
                {data.document_count}개 보기 ›
              </button>
            </dd>
          </dl>
          <div>
            <button
              type="button"
              className="primary"
              disabled={!newest}
              title={newest ? `${newest.document_name} · ${regionLabel(newest.sheet_name, newest.range)}` : "아직 추출된 값이 없어 원본을 열 수 없습니다."}
              onClick={() => newest && openReview(newest)}
            >
              Source Review 열기
            </button>
            {!newest && !values.loading && (
              <p className="app-muted app-small" role="note">
                아직 추출된 값이 없습니다. 이 필드를 쓰는 프로파일을 문서에 적용하면 원본을 열 수 있습니다.
              </p>
            )}
          </div>
          <h4>최근 값</h4>
          <State resource={values} empty="추출된 값이 없습니다." />
          {recent.length > 0 && (
            <ul className="app-plain-list app-recent-values" aria-label="최근 값">
              {recent.map((v) => (
                <li key={v.value_id}>
                  <div className="app-recent-value">
                    <strong>{v.text}</strong>
                    <small className="app-muted" title={formatDateTime(v.captured_at)}>
                      {v.document_name} · {regionLabel(v.sheet_name, v.range)} · {relativeTime(v.captured_at)}
                    </small>
                  </div>
                  <button type="button" className="small" onClick={() => openReview(v)}>
                    원본 보기
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function FieldLinks({ keys, nameOf, onSelect }: { keys: string[] | null | undefined; nameOf: (key: string) => string; onSelect: (key: string) => void }) {
  if (!keys?.length) return <span className="app-muted">없음</span>;
  return (
    <span className="app-chips">
      {keys.map((k) => (
        <button key={k} type="button" className="link" onClick={() => onSelect(k)}>
          {nameOf(k)}
        </button>
      ))}
    </span>
  );
}

function FieldEditForm({ field, path, onCancel, onSaved }: { field: FieldDetailData; path: string; onCancel: () => void; onSaved: (next: FieldDetailData) => void }) {
  const [form, setForm] = useState({
    name: field.name,
    description: field.description || "",
    aliases: (field.aliases || []).join(", "),
    status: field.status === "deprecated" ? "deprecated" : "active",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const patch = fieldPatch(field, form);
  const dirty = Object.keys(patch).length > 0;
  const invalid = !form.name.trim();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (invalid || !dirty) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api<FieldDetailData | null>(path, patch, { method: "PATCH" });
      onSaved({ ...field, ...patch, ...(saved && typeof saved === "object" ? saved : {}) });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="app-form app-stack" aria-label="필드 편집" onSubmit={submit}>
      <label>
        필드명
        <input value={form.name} aria-invalid={invalid || undefined} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </label>
      <label>
        설명
        <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </label>
      <label>
        Alias
        <input value={form.aliases} placeholder="쉼표로 구분" onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
      </label>
      <label>
        상태
        <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="active">활성</option>
          <option value="deprecated">폐기</option>
        </select>
      </label>
      {error && (
        <div className="app-error" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="app-inline">
        <button type="submit" className="primary" disabled={saving || invalid || !dirty}>
          저장
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          취소
        </button>
      </div>
    </form>
  );
}
