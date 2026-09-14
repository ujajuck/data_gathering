// 파싱 프로파일 화면(§7 Profiles): 목록(검색 250ms · 상태 필터 · 외부 Profile Import · 새 프로파일) → 상세(?profile=)는
// ProfileDetail, 가져오기 대화상자는 ProfileImport. 상세를 열면 목록은 왼쪽의 좁은 목록으로 접힌다.
import { useState } from "react";
import { Pager, State, formatDateTime, relativeTime, useDebounced, useNavigation, usePage, useToast, withQuery } from "./client";
import type { ProfileRow, ProfileStatus } from "./types";
import { PROFILE_STATUS_LABELS } from "./types";
import { Heading, ProfileStatusChip } from "./ui";
import ProfileDetail from "./ProfileDetail";
import ProfileImport from "./ProfileImport";
import type { ImportMode } from "./ProfileImport";

const PROFILE_STATUSES: ProfileStatus[] = ["draft", "approved", "deprecated"];
const isProfileStatus = (value: string | undefined): value is ProfileStatus =>
  !!value && (PROFILE_STATUSES as string[]).includes(value);

export default function Profiles() {
  const { route, go, refresh } = useNavigation();
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  // 문서 화면의 status(문서 상태)가 남아 있어도 프로파일 상태가 아니면 무시한다.
  const status = isProfileStatus(route.status) ? route.status : "";
  const profiles = usePage<ProfileRow>(withQuery("/profiles", { q, status, schema_key: route.schema_key }), refresh);
  const items = profiles.items;
  const selected = route.profile || "";
  const [dialog, setDialog] = useState<ImportMode | null>(null);
  const open = (id: string) => go({ profile: id, tab: "", rev: "" });
  return (
    <>
      <div inert={dialog ? true : undefined}>
        <Heading
          title="파싱 프로파일"
          description="문서 양식에서 데이터를 찾는 규칙을 관리하고 실제 파일에 적용해 검증합니다."
          actions={
            <>
              <button type="button" onClick={() => setDialog("import")}>
                외부 Profile Import
              </button>
              <button type="button" className="primary" onClick={() => setDialog("new")}>
                새 프로파일
              </button>
            </>
          }
        />
        <div className={selected ? "v3-split two" : ""}>
          <section className="v3-card">
            <div className="v3-toolbar" role="search" aria-label="프로파일 필터">
              <label className="v3-grow">
                프로파일 검색
                <input placeholder="프로파일명" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label>
                상태
                <select value={status} onChange={(e) => go({ status: e.target.value })}>
                  <option value="">전체</option>
                  {PROFILE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {PROFILE_STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </label>
              {route.schema_key && (
                <button type="button" className="small" onClick={() => go({ schema_key: "" })}>
                  스키마 필터 해제
                </button>
              )}
            </div>
            <State
              resource={profiles}
              empty={q || status ? "조건에 맞는 파싱 프로파일이 없습니다." : "아직 파싱 프로파일이 없습니다. 외부 JSON을 가져오거나 새로 만드세요."}
              action={
                <button type="button" className="primary" onClick={() => setDialog("new")}>
                  새 프로파일
                </button>
              }
            />
            {items.length > 0 && (selected ? <SideList items={items} selected={selected} onSelect={open} /> : <ListTable items={items} onSelect={open} loading={profiles.loading} />)}
            <Pager page={profiles} />
          </section>
          {selected && <ProfileDetail key={selected} profileId={selected} />}
        </div>
      </div>
      {dialog && (
        <ProfileImport
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(profile) => {
            setDialog(null);
            notify(`${profile.profile_name} v${profile.current_rev} 저장됨`);
            profiles.reset();
            open(profile.profile_id);
          }}
        />
      )}
    </>
  );
}

function ListTable({ items, onSelect, loading }: { items: ProfileRow[]; onSelect: (id: string) => void; loading: boolean }) {
  return (
    <div className="v3-table-wrap">
      <table className="v3-table" aria-label="파싱 프로파일 목록" aria-busy={loading || undefined}>
        <thead>
          <tr>
            <th scope="col">프로파일명</th>
            <th scope="col">버전</th>
            <th scope="col">연결 스키마</th>
            <th scope="col">적용 문서 수</th>
            <th scope="col">상태</th>
            <th scope="col">최근 수정</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.profile_id} className="clickable" onClick={() => onSelect(p.profile_id)}>
              <td>
                <button
                  type="button"
                  className="link"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(p.profile_id);
                  }}
                >
                  {p.profile_name}
                </button>
              </td>
              <td>v{p.current_rev}</td>
              <td>{p.schema?.name || <span className="v3-muted">-</span>}</td>
              <td className="num">{p.document_count}</td>
              <td>
                <ProfileStatusChip status={p.status} />
              </td>
              <td title={formatDateTime(p.updated_at)}>{relativeTime(p.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SideList({ items, selected, onSelect }: { items: ProfileRow[]; selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="v3-list v3-side-list" aria-label="파싱 프로파일 목록">
      {items.map((p) => (
        <button
          key={p.profile_id}
          type="button"
          className={"v3-list-item" + (p.profile_id === selected ? " selected" : "")}
          aria-current={p.profile_id === selected ? "true" : undefined}
          onClick={() => onSelect(p.profile_id)}
        >
          <span>
            <strong>{p.profile_name}</strong>
            <small>
              v{p.current_rev} · {p.schema?.name || "-"} · 문서 {p.document_count}
            </small>
          </span>
          <ProfileStatusChip status={p.status} />
        </button>
      ))}
    </div>
  );
}
