// 문서 화면(§7 Documents): 상단 `문서 검색(250ms) · 상태 필터 · 프로파일 필터 · + 문서 등록`, 표 `[선택] · 문서명 · 상태 ·
// 적용 프로파일(vN, +N) · 연결 스키마 · 현재 Snapshot · 최근 처리`, 정렬 헤더(열마다 첫 방향), keyset Pager,
// 다중 선택 → 고정 하단 바 `N개 선택 · 데이터 빌드에 추가`(토스트 `N개 문서 · 데이터 빌드로 이동 ›`).
// 행 클릭 → DocumentDetail(모달, ?document=). `+ 문서 등록` → DocumentRegister.
import { useState } from "react";
import {
  Pager,
  State,
  formatDateTime,
  profileLabel,
  relativeTime,
  snapshotLabel,
  useData,
  useDebounced,
  useNavigation,
  usePage,
  useToast,
  withQuery,
} from "./client";
import type { DocumentRow, DocumentStatus, Page, ProfileRow } from "./types";
import { STATUS_LABELS, STATUS_ORDER } from "./types";
import { Chip, Heading, StatusChip, statusDetailText } from "./ui";
import { addToBuildDraft } from "./buildDraft";
import DocumentDetail from "./DocumentDetail";
import DocumentRegister from "./DocumentRegister";

type SortKey = "document_name" | "status" | "last_processed_at";
const COLUMNS: { key: SortKey | null; label: string; firstDirection?: "asc" | "desc" }[] = [
  { key: "document_name", label: "문서명" },
  { key: "status", label: "상태" },
  { key: null, label: "적용 프로파일" },
  { key: null, label: "연결 스키마" },
  { key: null, label: "현재 Snapshot" },
  { key: "last_processed_at", label: "최근 처리", firstDirection: "desc" },
];
const DEFAULT_SORT = "-last_processed_at";

// 적용 프로파일 열: 첫 항목 `name vN`, 2개 이상이면 `+N`, 툴팁에 전체 목록.
export function ProfileCell({ profiles }: { profiles: DocumentRow["profiles"] }) {
  if (!profiles?.length) return <span className="v3-muted">-</span>;
  const [first, ...rest] = profiles;
  return (
    <span title={profiles.map(profileLabel).join(", ")}>
      {profileLabel(first)}
      {rest.length > 0 && <span className="v3-muted"> +{rest.length}</span>}
    </span>
  );
}

export default function Documents() {
  const { route, go, refresh, changed } = useNavigation();
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), 250);
  const status = route.status || "";
  const profileId = route.profile_id || "";
  const sort = route.sort || DEFAULT_SORT;
  const [selected, setSelected] = useState<string[]>([]);
  const [registerOpen, setRegisterOpen] = useState(false);
  const documents = usePage<DocumentRow>(
    withQuery("/documents", { q: search, status, profile_id: profileId, schema_key: route.schema_key, sort }),
    refresh,
  );
  const profiles = useData<Page<ProfileRow>>("/profiles");
  const items = documents.items;
  const detailOpen = !!route.document;
  const filtered = !!(search || status || profileId || route.schema_key);
  const sortKey = sort.replace(/^-/, "");
  const direction = sort.startsWith("-") ? "desc" : "asc";

  // v2 DocumentsTable 패턴: 같은 열을 다시 누르면 방향 반전, 다른 열은 그 열의 첫 방향.
  function sortBy(key: SortKey, firstDirection: "asc" | "desc" = "asc") {
    const next = sortKey === key ? (direction === "asc" ? "-" + key : key) : firstDirection === "desc" ? "-" + key : key;
    go({ sort: next });
  }
  function clearFilters() {
    setQuery("");
    go({ status: "", profile_id: "", schema_key: "" });
  }
  const pageIds = items.map((d) => d.document_id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));
  function addSelected(ids: string[]) {
    const added = addToBuildDraft(ids);
    notify(`${ids.length}개 문서 · 데이터 빌드로 이동 ›` + (added < ids.length ? " (이미 담긴 문서 포함)" : ""), {
      label: "데이터 빌드로 이동",
      onClick: () => go({ screen: "build" }),
    });
    setSelected([]);
  }
  const openDocument = (doc: DocumentRow) => go({ document: doc.document_id, tab: "", sheet: "" });
  const backgroundInert = detailOpen || registerOpen;

  return (
    <>
      <div inert={backgroundInert || undefined}>
        <Heading
          title="문서"
          description="실제 입력 파일과 적용된 파싱 프로파일·파싱 스키마를 확인합니다."
          actions={
            <button type="button" className="primary" onClick={() => setRegisterOpen(true)}>
              + 문서 등록
            </button>
          }
        />
        <section className="v3-card">
          <div className="v3-toolbar" role="search" aria-label="문서 필터">
            <label className="v3-grow">
              문서 검색
              <input placeholder="문서명 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <label>
              상태
              <select value={status} onChange={(e) => go({ status: e.target.value })}>
                <option value="">전체</option>
                {STATUS_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              파싱 프로파일
              <select value={profileId} onChange={(e) => go({ profile_id: e.target.value })}>
                <option value="">전체</option>
                {profiles.data?.items.map((p) => (
                  <option key={p.profile_id} value={p.profile_id}>
                    {profileLabel({ profile_name: p.profile_name, rev: p.current_rev })}
                  </option>
                ))}
                {profileId && !profiles.data?.items.some((p) => p.profile_id === profileId) && <option value={profileId}>선택한 프로파일</option>}
              </select>
            </label>
            {route.schema_key && (
              <Chip kind="blue" title="파싱 스키마 화면에서 넘어온 필터">
                스키마 필터
              </Chip>
            )}
            {filtered && (
              <button type="button" className="small" onClick={clearFilters}>
                필터 해제
              </button>
            )}
            <span className="v3-toolbar-end v3-muted v3-small" role="status">
              {documents.loading ? "" : `${items.length}건 표시 · ${documents.number} 페이지`}
            </span>
          </div>
          <State
            resource={documents}
            empty={filtered ? "조건에 맞는 문서가 없습니다." : "아직 등록된 문서가 없습니다. 원본 폴더에서 문서를 등록하면 파싱 프로파일이 자동으로 적용됩니다."}
            action={
              filtered ? (
                <button type="button" onClick={clearFilters}>
                  필터 해제
                </button>
              ) : (
                <button type="button" className="primary" onClick={() => setRegisterOpen(true)}>
                  문서 등록하기
                </button>
              )
            }
          />
          {items.length > 0 && (
            <div className="v3-table-wrap">
              <table className="v3-table" aria-label="문서 목록" aria-busy={documents.loading || undefined}>
                <thead>
                  <tr>
                    <th scope="col">
                      <input
                        type="checkbox"
                        aria-label="전체 선택"
                        checked={allSelected}
                        onChange={(e) =>
                          setSelected((list) => (e.target.checked ? [...new Set([...list, ...pageIds])] : list.filter((id) => !pageIds.includes(id))))
                        }
                      />
                    </th>
                    {COLUMNS.map((column) => (
                      <th
                        key={column.label}
                        scope="col"
                        aria-sort={column.key ? (sortKey === column.key ? (direction === "asc" ? "ascending" : "descending") : "none") : undefined}
                      >
                        {column.key ? (
                          <button type="button" onClick={() => sortBy(column.key!, column.firstDirection)}>
                            {column.label}
                          </button>
                        ) : (
                          column.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((doc) => (
                    <tr
                      key={doc.document_id}
                      className={"clickable" + (selected.includes(doc.document_id) ? " selected" : "")}
                      onClick={() => openDocument(doc)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`${doc.document_name} 선택`}
                          checked={selected.includes(doc.document_id)}
                          onChange={(e) =>
                            setSelected((list) =>
                              e.target.checked ? [...new Set([...list, doc.document_id])] : list.filter((id) => id !== doc.document_id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="link"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDocument(doc);
                          }}
                        >
                          {doc.document_name}
                        </button>
                      </td>
                      <td>
                        <StatusChip status={doc.status as DocumentStatus} detail={statusDetailText(doc.status_detail, doc.last_error)} />
                      </td>
                      <td>
                        <ProfileCell profiles={doc.profiles} />
                      </td>
                      <td>{doc.schemas?.length ? doc.schemas.map((s) => s.schema_name).join(", ") : <span className="v3-muted">-</span>}</td>
                      <td>
                        {doc.current_snapshot ? (
                          <span className="v3-inline">
                            {snapshotLabel(doc.current_snapshot)}
                            <Chip kind="blue">최신</Chip>
                          </span>
                        ) : (
                          <span className="v3-muted">없음</span>
                        )}
                      </td>
                      <td title={doc.last_processed_at ? formatDateTime(doc.last_processed_at) : undefined}>
                        {relativeTime(doc.last_processed_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager page={documents} />
          {selected.length > 0 && (
            <div className="v3-selection-bar v3-sticky-bottom" role="region" aria-label="선택한 문서">
              <span>{selected.length}개 선택</span>
              <button type="button" className="small" onClick={() => setSelected([])}>
                선택 해제
              </button>
              <button type="button" className="primary" onClick={() => addSelected(selected)}>
                데이터 빌드에 추가
              </button>
            </div>
          )}
        </section>
      </div>
      {detailOpen && <DocumentDetail documentId={route.document} onAddToBuild={(id) => addSelected([id])} />}
      {registerOpen && (
        <DocumentRegister
          onClose={() => {
            setRegisterOpen(false);
            // 등록 작업이 아직 진행 중이어도 목록을 한 번 새로 읽는다(작업 자체는 JobBar에서 이어진다).
            changed();
          }}
          onRegistered={changed}
        />
      )}
    </>
  );
}
