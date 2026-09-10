import { useRef, useState } from "react";
import { Pager, State, useDraft, useNavigation, usePage } from "./client";
import type { Row } from "./client";

export type TemplateState = "published" | "review" | "pending" | "failed";
export type DocumentRow = {
  document_id: string;
  display_name: string;
  provider: string;
  file_type: string;
  current_version_id: string;
  registered_at: string;
  author: string | null;
  authored_at: string | null;
  access_status: string;
  extraction_status: string;
  templates: {
    application_id: string;
    template_id: string;
    template_version_id: string;
    name: string;
    revision_no: number;
    state: TemplateState;
  }[];
  template_count: number;
  review_pending: number;
  roots: { concept_id: string; name: string }[];
  root_count: number;
};
export const ACCESS_LABELS: Record<string, string> = {
  allowed: "접근 가능",
  denied: "접근 불가",
  expired: "확인 만료",
  unknown: "미확인",
};
export const ACCESS_CLASS: Record<string, string> = {
  allowed: "green",
  denied: "red",
  expired: "amber",
  unknown: "amber",
};
export const EXTRACTION_LABELS: Record<string, string> = {
  unassigned: "미배정",
  review: "검수 필요",
  pending: "추출 필요",
  published: "발행됨",
  failed: "실패",
};
export const EXTRACTION_CLASS: Record<string, string> = {
  unassigned: "",
  review: "amber",
  pending: "blue",
  published: "green",
  failed: "red",
};
// 적용 건마다 같은 단어를 쓴다(발행됨 · 검수 필요 · 추출 필요 · 실패).
export const TEMPLATE_STATE_LABELS = EXTRACTION_LABELS;
export const COLUMNS = [
  ["name", "파일"],
  ["author", "작성자"],
  ["authored_at", "작성일"],
  [null, "문서군"],
  ["template", "템플릿"],
  ["review", "검수"],
  [null, "접근"],
  [null, "상태"],
] as const;
const FIRST_DIRECTION: Record<string, "asc" | "desc"> = {
  review: "desc",
  authored_at: "desc",
};
const EMPTY_FILTERS: Record<string, string> = {
  author: "",
  date_from: "",
  date_to: "",
  access_status: "",
  extraction_status: "",
  template: "",
  sort: "name",
  direction: "asc",
};

// 목록 응답에 새 필드가 없어도(이전 서버·오래된 픽스처) 행을 그린다.
export function normalize(row: Row): DocumentRow {
  return {
    ...row,
    author: row.author ?? null,
    authored_at: row.authored_at ?? null,
    access_status: row.access_status || "unknown",
    extraction_status: row.extraction_status || "unassigned",
    templates: Array.isArray(row.templates) ? row.templates : [],
    template_count: Number(row.template_count) || 0,
    review_pending: Number(row.review_pending) || 0,
    roots: Array.isArray(row.roots) ? row.roots : [],
    root_count: Number(row.root_count) || 0,
  } as DocumentRow;
}
export function openDocument(
  go: (next: Record<string, string>) => void,
  doc: Pick<DocumentRow, "document_id" | "current_version_id">,
) {
  go({
    document: doc.document_id,
    version: doc.current_version_id,
    sheet: "",
    application: "",
    mapping: "",
    series: "",
    item: "",
  });
}

export default function DocumentsTable() {
  const { route, go, refresh } = useNavigation();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useDraft<Record<string, string>>(
    "document-filters",
    EMPTY_FILTERS,
  );
  const documents = usePage(
    "/documents?q=" +
      encodeURIComponent(search) +
      "&r=" +
      refresh +
      "&" +
      new URLSearchParams(
        Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
      ),
  );
  // 정렬·필터를 바꿔 다시 불러오는 동안에도 표(헤더 포함)를 유지한다.
  const shown = useRef<DocumentRow[]>([]);
  if (documents.data) shown.current = documents.data.items.map(normalize);
  else if (!documents.loading) shown.current = [];
  const items = shown.current;
  const sort = filters.sort || "name";
  const direction = filters.direction === "desc" ? "desc" : "asc";
  function sortBy(key: string) {
    setFilters((f) =>
      f.sort === key
        ? { ...f, direction: f.direction === "desc" ? "asc" : "desc" }
        : { ...f, sort: key, direction: FIRST_DIRECTION[key] ?? "asc" },
    );
  }
  function reset() {
    setQuery("");
    setSearch("");
    setFilters((f) => ({
      ...EMPTY_FILTERS,
      sort: f.sort,
      direction: f.direction,
    }));
  }
  const field = (key: string) => ({
    value: filters[key] || "",
    onChange: (e: { target: { value: string } }) =>
      setFilters((f) => ({ ...f, [key]: e.target.value })),
  });
  return (
    <section className="v2-card">
      <div className="v2-card-head">
        <h2>등록 문서</h2>
        <span className="v2-doc-count" role="status">
          {items.length}건 표시 · {documents.number} 페이지
        </span>
      </div>
      <form
        className="v2-doc-toolbar"
        role="search"
        aria-label="문서 필터"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query);
        }}
      >
        <input
          className="v2-doc-search"
          aria-label="문서 검색"
          placeholder="문서명 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label>
          작성자
          <input {...field("author")} />
        </label>
        <label>
          작성일 시작
          <input type="date" {...field("date_from")} />
        </label>
        <label>
          작성일 종료
          <input type="date" {...field("date_to")} />
        </label>
        <label>
          접근 상태
          <select {...field("access_status")}>
            <option value="">전체</option>
            <option value="allowed">접근 가능</option>
            <option value="denied">접근 불가</option>
            <option value="expired">확인 만료</option>
            <option value="unknown">미확인</option>
          </select>
        </label>
        <label>
          추출 상태
          <select {...field("extraction_status")}>
            <option value="">전체</option>
            <option value="unassigned">미배정</option>
            <option value="review">검수 필요</option>
            <option value="pending">추출 필요</option>
            <option value="published">발행됨</option>
            <option value="failed">실패</option>
          </select>
        </label>
        <label>
          적용 템플릿
          <input {...field("template")} />
        </label>
        <button>검색</button>
        <button type="button" onClick={reset}>
          초기화
        </button>
      </form>
      <p className="v2-muted">
        접근 상태는 최근 확인 결과입니다. 원본을 열거나 추출할 때 권한을 다시
        확인합니다.
      </p>
      <State
        resource={documents}
        empty="원본 폴더의 파일을 선택해 첫 문서를 등록하세요."
      />
      {items.length > 0 && (
        <div className="v2-doc-table">
          <table
            className="v2-table"
            aria-label="등록 문서 목록"
            aria-busy={documents.loading || undefined}
          >
            <thead>
              <tr>
                {COLUMNS.map(([key, label]) =>
                  key ? (
                    <th
                      key={label}
                      scope="col"
                      aria-sort={
                        sort === key
                          ? direction === "asc"
                            ? "ascending"
                            : "descending"
                          : "none"
                      }
                    >
                      <button
                        type="button"
                        className="v2-th-sort"
                        onClick={() => sortBy(key)}
                      >
                        {label}
                        <span aria-hidden="true" className="v2-sort-mark">
                          {sort === key
                            ? direction === "asc"
                              ? "▲"
                              : "▼"
                            : ""}
                        </span>
                      </button>
                    </th>
                  ) : (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ),
                )}
                <th scope="col">
                  <span className="v2-visually-hidden">열기</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((doc) => (
                <DocumentTableRow
                  key={doc.document_id}
                  doc={doc}
                  selected={route.document === doc.document_id}
                  go={go}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={documents} />
    </section>
  );
}

function DocumentTableRow({
  doc,
  selected,
  go,
}: {
  doc: DocumentRow;
  selected: boolean;
  go: (next: Record<string, string>) => void;
}) {
  const hidden = doc.root_count - doc.roots.length;
  const review =
    doc.templates.find((t) => t.state === "review") || doc.templates[0];
  return (
    <tr
      className={selected ? "selected" : ""}
      aria-selected={selected}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        openDocument(go, doc);
      }}
    >
      <td className="v2-cell-file">
        <strong>{doc.display_name}</strong>
        <small>
          {doc.provider} · {(doc.file_type || "xlsx").toUpperCase()}
        </small>
      </td>
      <td>{doc.author || "—"}</td>
      <td className="v2-nowrap" title={doc.authored_at || ""}>
        {(doc.authored_at || "").slice(0, 10) || "—"}
      </td>
      <td>
        {doc.roots.length
          ? doc.roots.map((r) => (
              <span
                key={r.concept_id}
                className="v2-badge outline"
                title={"문서군 · " + r.name}
              >
                {r.name}
              </span>
            ))
          : "—"}
        {hidden > 0 && <span className="v2-badge">+{hidden}</span>}
      </td>
      <td>
        {doc.templates.length ? (
          doc.templates.map((t) => (
            <span
              key={t.application_id}
              className={"v2-badge blue" + (t.state === "failed" ? " red" : "")}
              title={
                "파싱 템플릿 · " + (TEMPLATE_STATE_LABELS[t.state] ?? t.state)
              }
            >
              {t.name} v{t.revision_no}
            </span>
          ))
        ) : (
          <span className="v2-badge muted">미배정</span>
        )}
      </td>
      <td>
        {doc.review_pending > 0 ? (
          <button
            type="button"
            className="v2-secondary"
            onClick={() =>
              go({
                tab: "source",
                document: doc.document_id,
                version: doc.current_version_id,
                application: review?.application_id || "",
                mapping: "",
                sheet: "",
                series: "",
                item: "",
              })
            }
          >
            {doc.review_pending}건 검수
          </button>
        ) : (
          "—"
        )}
      </td>
      <td>
        <span
          className={"v2-badge " + (ACCESS_CLASS[doc.access_status] ?? "amber")}
        >
          {ACCESS_LABELS[doc.access_status] ?? "미확인"}
        </span>
      </td>
      <td>
        <span
          className={
            "v2-badge " + (EXTRACTION_CLASS[doc.extraction_status] ?? "")
          }
        >
          {EXTRACTION_LABELS[doc.extraction_status] ?? "미배정"}
        </span>
      </td>
      <td className="v2-nowrap">
        <button
          type="button"
          className="v2-secondary"
          onClick={() => openDocument(go, doc)}
        >
          열어보기
        </button>
      </td>
    </tr>
  );
}
