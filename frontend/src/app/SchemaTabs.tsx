// 파싱 스키마 상세 탭(§7 Schema): 사용 프로파일(GET /schemas/{key}/profiles?field_key=) · 연관 문서(GET /schemas/{key}/documents
// ?field_key=&cursor=, keyset) · 변경 이력(GET /schemas/{key}/revisions). 필드 상세의 'N개 보기 ›'는 ?field_filter=로 같은 목록을 거른다.
import { Pager, State, formatDateTime, profileLabel, reviewRoute, snapshotLabel, useData, useNavigation, usePage, withQuery } from "./client";
import type { Page, RevisionRow, SchemaDocumentRow, SchemaProfileRow } from "./types";
import { Chip, ProfileStatusChip, StatusChip } from "./ui";

export function FieldFilterBar({ fieldName, onClear }: { fieldName: string; onClear: () => void }) {
  return (
    <div className="app-toolbar" role="status" aria-label="필드 필터">
      <span className="app-small">
        필드 <Chip kind="blue">{fieldName}</Chip> 기준으로 거른 목록
      </span>
      <button type="button" className="small" onClick={onClear}>
        필터 해제
      </button>
    </div>
  );
}

export function SchemaProfilesTab({ schemaKey, fieldKey }: { schemaKey: string; fieldKey: string }) {
  const { reset } = useNavigation();
  const profiles = useData<Page<SchemaProfileRow>>(withQuery(`/schemas/${encodeURIComponent(schemaKey)}/profiles`, { field_key: fieldKey }));
  const items = profiles.data?.items ?? [];
  const open = (id: string) => reset({ screen: "profiles", profile: id });
  return (
    <>
      <State resource={profiles} empty={fieldKey ? "이 필드를 쓰는 파싱 프로파일이 없습니다." : "이 스키마를 쓰는 파싱 프로파일이 없습니다."} />
      {items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="사용 프로파일" aria-busy={profiles.loading || undefined}>
            <thead>
              <tr>
                <th scope="col">프로파일명</th>
                <th scope="col">버전</th>
                <th scope="col">규칙</th>
                <th scope="col">적용 문서</th>
                <th scope="col">상태</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.profile_id} className="clickable" onClick={() => open(p.profile_id)}>
                  <td>
                    <button
                      type="button"
                      className="link"
                      onClick={(e) => {
                        e.stopPropagation();
                        open(p.profile_id);
                      }}
                    >
                      {p.profile_name}
                    </button>
                  </td>
                  <td>v{p.current_rev}</td>
                  <td>
                    {p.rules?.count ?? 0}
                    {p.rules?.keys?.length ? <small className="app-muted"> · {p.rules.keys.slice(0, 5).join(", ")}</small> : null}
                  </td>
                  <td className="num">{p.document_count}</td>
                  <td>
                    <ProfileStatusChip status={p.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function SchemaDocumentsTab({ schemaKey, fieldKey }: { schemaKey: string; fieldKey: string }) {
  const { go, reset } = useNavigation();
  const documents = usePage<SchemaDocumentRow>(withQuery(`/schemas/${encodeURIComponent(schemaKey)}/documents`, { field_key: fieldKey }));
  const items = documents.items;
  return (
    <>
      <State resource={documents} empty={fieldKey ? "이 필드가 추출된 문서가 없습니다." : "이 스키마로 파싱된 문서가 없습니다."} />
      {items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="연관 문서" aria-busy={documents.loading || undefined}>
            <thead>
              <tr>
                <th scope="col">문서명</th>
                <th scope="col">사용 프로파일</th>
                <th scope="col">Snapshot</th>
                <th scope="col">상태</th>
                <th scope="col">원본 보기</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.document_id + ":" + d.application_id}>
                  <td>
                    <button type="button" className="link" onClick={() => reset({ screen: "documents", document: d.document_id })}>
                      {d.document_name}
                    </button>
                  </td>
                  <td>{profileLabel(d.profile)}</td>
                  <td title={d.snapshot ? formatDateTime(d.snapshot.captured_at) : undefined}>{snapshotLabel(d.snapshot)}</td>
                  <td>
                    <StatusChip status={d.status} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="small"
                      disabled={!d.application_id}
                      title={d.application_id ? undefined : "적용된 프로파일이 없어 원본을 열 수 없습니다."}
                      onClick={() => go(reviewRoute({ application_id: d.application_id }))}
                    >
                      원본 보기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager page={documents} />
    </>
  );
}

export function SchemaHistoryTab({ schemaKey, currentRev, version = 0 }: { schemaKey: string; currentRev: number; version?: number }) {
  // version은 쓰기(필드 편집·새 리비전) 뒤 다시 읽기 위한 카운터.
  const revisions = useData<Page<RevisionRow>>(`/schemas/${encodeURIComponent(schemaKey)}/revisions`, version);
  const items = revisions.data?.items ?? [];
  return (
    <>
      <p className="app-muted app-small">정의 파일 리비전. 필드 편집·필드 삭제도 새 리비전을 만듭니다. 새 리비전은 위 '새 리비전' 버튼으로 올립니다.</p>
      <State resource={revisions} empty="변경 이력이 없습니다." />
      {items.length > 0 && (
        <div className="app-table-wrap">
          <table className="app-table" aria-label="변경 이력">
            <thead>
              <tr>
                <th scope="col">버전</th>
                <th scope="col">일시</th>
                <th scope="col">필드</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.rev}>
                  <td>
                    v{r.rev} {r.rev === currentRev && <Chip kind="blue">현재</Chip>}
                  </td>
                  <td>{formatDateTime(r.created_at)}</td>
                  <td>필드 {r.field_count ?? 0}개</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
