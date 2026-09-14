// 파싱 스키마 화면(§7 Schema, ui-development-spec §5): 3열 — 좌 스키마 목록(GET /schemas, 검색 250ms 클라이언트 필터, '새 스키마'는 생성 전용)
// / 중앙 상세(?schema=): 헤더(이름 vN · 상태 · '새 리비전' · '삭제') + 탭 `구조 보기 · 사용 프로파일 (N) · 연관 문서 (N) · 변경 이력`; 구조 보기 안에서만
// [트리 보기] [그래프 보기] 토글(?view=tree|graph) / 우 필드 상세(?field_key=). 진입 호출 = /schemas · /schemas/{key} · /schemas/{key}/tree (≤3);
// 그래프는 그래프 보기일 때만, 필드 상세는 선택 시. 탭의 ?field_filter=는 필드 상세의 'N개 보기 ›'가 건다.
import { useMemo, useState } from "react";
import { State, api, schemaLabel, useData, useDebounced, useNavigation, useToast } from "./client";
import type { FieldDeleteResult, Page, SchemaDeleteResult, SchemaDetail, SchemaGraph as SchemaGraphData, SchemaRow, SchemaTree as SchemaTreeData } from "./types";
import { Chip, Heading, Tabs } from "./ui";
import SchemaTree, { flattenTree } from "./SchemaTree";
import SchemaGraph from "./SchemaGraph";
import FieldDetail from "./FieldDetail";
import SchemaEditor, { FieldCreateDialog } from "./SchemaEditor";
import type { SchemaEditorMode } from "./SchemaEditor";
import DeleteDialog from "./DeleteDialog";
import { CHILDREN_CODE } from "./DeleteDialog";
import { FieldFilterBar, SchemaDocumentsTab, SchemaHistoryTab, SchemaProfilesTab } from "./SchemaTabs";

export type SchemaTab = "structure" | "profiles" | "documents" | "history";
const TABS: SchemaTab[] = ["structure", "profiles", "documents", "history"];
export type StructureView = "tree" | "graph";

// 스키마를 지울 수 있는 상태인가 — 서버(§4.2.1)가 막는 기준과 같다. 언제나 실패하는 버튼은 띄우지 않는다.
export function deletable(detail: SchemaDetail): boolean {
  return detail.profile_count === 0 && (detail.application_count ?? detail.document_count) === 0;
}

export function schemaStatus(status: string | null | undefined): { label: string; kind: "ok" | "muted" | "warn" } {
  if (!status || status === "active") return { label: "활성", kind: "ok" };
  if (status === "deprecated") return { label: "폐기", kind: "muted" };
  if (status === "draft") return { label: "초안", kind: "warn" };
  return { label: status, kind: "muted" };
}

export default function Schema() {
  const { route, go, refresh } = useNavigation();
  const { notify } = useToast();
  const [query, setQuery] = useState("");
  const q = useDebounced(query.trim(), 250);
  const [dialog, setDialog] = useState<SchemaEditorMode | null>(null);
  const [addingField, setAddingField] = useState(false);
  // 삭제 확인 대화상자: 스키마 전체 또는 선택한 필드. 뒤 화면 inert를 한 곳에서 관리하려고 여기서 연다.
  const [deleting, setDeleting] = useState<"" | "schema" | "field">("");
  const [written, setWritten] = useState(0);
  // 지운 스키마는 목록이 다시 읽힐 때까지 화면에서 바로 뺀다(없는 키를 다시 읽어 404가 번쩍이지 않게).
  const [removed, setRemoved] = useState("");
  const version = refresh + written;

  const schemas = useData<Page<SchemaRow>>("/schemas", version);
  const all = (schemas.data?.items ?? []).filter((s) => s.schema_key !== removed);
  const filtered = useMemo(() => {
    const needle = q.toLowerCase();
    return needle ? all.filter((s) => s.schema_name.toLowerCase().includes(needle) || s.schema_key.toLowerCase().includes(needle)) : all;
  }, [all, q]);
  const key = route.schema || all[0]?.schema_key || "";
  const encoded = encodeURIComponent(key);
  const detail = useData<SchemaDetail>(key ? "/schemas/" + encoded : null, version);
  const tree = useData<SchemaTreeData>(key ? "/schemas/" + encoded + "/tree" : null, version);
  const tab: SchemaTab = (TABS as string[]).includes(route.tab) ? (route.tab as SchemaTab) : "structure";
  const view: StructureView = route.view === "graph" ? "graph" : "tree";
  const graph = useData<SchemaGraphData>(key && tab === "structure" && view === "graph" ? "/schemas/" + encoded + "/graph" : null, version);
  const fieldKey = route.field_key || route.field || "";
  const fieldFilter = route.field_filter || "";
  const flat = useMemo(() => flattenTree(tree.data?.nodes ?? []), [tree.data]);
  const names = useMemo(() => new Map(flat.map((item) => [item.node.field_key, item.node.name])), [flat]);
  const parentChoices = useMemo(() => flat.map((item) => ({ field_key: item.node.field_key, name: item.node.name, level: item.node.level })), [flat]);
  const selectField = (field_key: string) => go({ field_key, field: "" });
  const selectSchema = (schema_key: string) => {
    // 지운 키를 기억해 둔 것은 그 삭제 직후 목록에서만 쓴다 — 다른 스키마를 고르거나 같은 키로 다시 만들면 잊는다.
    setRemoved("");
    go({ schema: schema_key, field_key: "", field: "", field_filter: "" });
  };
  const status = schemaStatus(detail.data?.status);
  const schemaName = detail.data?.schema_name || tree.data?.schema_name || key;

  return (
    <>
      <div inert={dialog || deleting || addingField ? true : undefined}>
        <Heading
          title="파싱 스키마"
          description="공통 데이터 구조를 트리 또는 그래프로 확인하고, 파싱 프로파일과 실제 문서까지 추적합니다."
          actions={
            <button type="button" className="primary" onClick={() => setDialog({ kind: "new" })}>
              새 스키마
            </button>
          }
        />
        <div className="app-split wide-right">
          <section className="app-card" aria-label="스키마 목록">
            <h3>스키마 목록{schemas.data ? ` (${all.length})` : ""}</h3>
            <label>
              스키마 검색
              <input placeholder="스키마명" value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
            <State
              resource={schemas}
              isEmpty={!!schemas.data && filtered.length === 0}
              empty={q ? "조건에 맞는 파싱 스키마가 없습니다." : "아직 파싱 스키마가 없습니다. 정의 JSON을 가져와 시작하세요."}
              action={
                q ? undefined : (
                  <button type="button" className="primary" onClick={() => setDialog({ kind: "new" })}>
                    새 스키마
                  </button>
                )
              }
            />
            {filtered.length > 0 && (
              <div className="app-list app-side-list" aria-label="파싱 스키마">
                {filtered.map((s) => (
                  <button
                    key={s.schema_key}
                    type="button"
                    className={"app-list-item" + (s.schema_key === key ? " selected" : "")}
                    aria-current={s.schema_key === key ? "true" : undefined}
                    onClick={() => selectSchema(s.schema_key)}
                  >
                    <span>
                      <strong>{s.schema_name}</strong>
                      <small>
                        필드 {s.field_count} · 프로파일 {s.profile_count} · 문서 {s.document_count}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="app-card" aria-label="스키마 상세">
            {!key && <State resource={detail} isEmpty={!schemas.loading} empty="왼쪽에서 파싱 스키마를 선택하세요." />}
            {key && <State resource={detail} isEmpty={false} />}
            {detail.data && (
              <>
                <div className="app-card-head">
                  <h2>
                    {schemaLabel({ schema_name: detail.data.schema_name, rev: detail.data.current_rev })} <Chip kind={status.kind}>{status.label}</Chip>
                  </h2>
                  <span className="app-inline">
                    <span className="app-muted app-small">
                      필드 {detail.data.field_count} · 프로파일 {detail.data.profile_count} · 문서 {detail.data.document_count}
                    </span>
                    <button
                      type="button"
                      className="small"
                      onClick={() => setDialog({ kind: "revision", schemaKey: key, schemaName: detail.data!.schema_name, currentRev: detail.data!.current_rev })}
                    >
                      새 리비전
                    </button>
                    <button
                      type="button"
                      className="small"
                      onClick={() => setDialog({ kind: "rename", schemaKey: key, schemaName: detail.data!.schema_name, currentRev: detail.data!.current_rev })}
                    >
                      이름 바꾸기
                    </button>
                    {deletable(detail.data) && (
                      <button type="button" className="small danger" onClick={() => setDeleting("schema")}>
                        삭제
                      </button>
                    )}
                  </span>
                </div>
                {detail.data.description && <p className="app-muted app-small">{detail.data.description}</p>}
                <Tabs<SchemaTab>
                  label="스키마 상세 탭"
                  value={tab}
                  onChange={(next) => go({ tab: next === "structure" ? "" : next })}
                  tabs={[
                    { id: "structure", label: "구조 보기" },
                    { id: "profiles", label: `사용 프로파일 (${detail.data.profile_count})` },
                    { id: "documents", label: `연관 문서 (${detail.data.document_count})` },
                    { id: "history", label: "변경 이력" },
                  ]}
                />
                {tab === "structure" && (
                  <div className="app-stack" role="tabpanel" aria-label="구조 보기">
                    <div className="app-toolbar">
                      <div className="app-segment" role="group" aria-label="구조 보기 방식">
                        <button type="button" aria-pressed={view === "tree"} onClick={() => go({ view: "" })}>
                          트리 보기
                        </button>
                        <button type="button" aria-pressed={view === "graph"} onClick={() => go({ view: "graph" })}>
                          그래프 보기
                        </button>
                      </div>
                      <span className="app-toolbar-end app-inline">
                        {fieldKey && (
                          <button type="button" className="small" onClick={() => go({ field_key: "", field: "" })}>
                            선택 해제
                          </button>
                        )}
                        <button type="button" className="small" onClick={() => setAddingField(true)}>
                          + 필드 추가
                        </button>
                      </span>
                    </div>
                    {view === "tree" && (
                      <>
                        <State resource={tree} isEmpty={!!tree.data && tree.data.nodes.length === 0} empty="필드가 없습니다. 새 리비전으로 필드를 추가하세요." />
                        {tree.data && tree.data.nodes.length > 0 && <SchemaTree rootName={schemaName} nodes={tree.data.nodes} selected={fieldKey} onSelect={selectField} />}
                      </>
                    )}
                    {view === "graph" && (
                      <>
                        <State resource={graph} isEmpty={!!graph.data && graph.data.nodes.length === 0} empty="그래프로 그릴 필드가 없습니다." />
                        {graph.data && graph.data.nodes.length > 0 && <SchemaGraph data={graph.data} schemaName={schemaName} selected={fieldKey} onSelect={selectField} />}
                      </>
                    )}
                  </div>
                )}
                {tab !== "structure" && fieldFilter && tab !== "history" && (
                  <FieldFilterBar fieldName={names.get(fieldFilter) || fieldFilter} onClear={() => go({ field_filter: "" })} />
                )}
                {tab === "profiles" && (
                  <div role="tabpanel" aria-label="사용 프로파일">
                    <SchemaProfilesTab key={fieldFilter} schemaKey={key} fieldKey={fieldFilter} />
                  </div>
                )}
                {tab === "documents" && (
                  <div role="tabpanel" aria-label="연관 문서">
                    <SchemaDocumentsTab key={fieldFilter} schemaKey={key} fieldKey={fieldFilter} />
                  </div>
                )}
                {tab === "history" && (
                  <div role="tabpanel" aria-label="변경 이력">
                    <SchemaHistoryTab schemaKey={key} version={version} currentRev={detail.data.current_rev} />
                  </div>
                )}
              </>
            )}
          </section>

          {key && fieldKey ? (
            <FieldDetail
              key={key + "/" + fieldKey}
              schemaKey={key}
              fieldKey={fieldKey}
              names={names}
              onOpenTab={(next, field_key) => go({ tab: next, field_filter: field_key })}
              onSaved={(field) => {
                notify(`${field.name} 필드 저장됨`);
                // 필드 편집은 새 리비전을 만들므로 목록·헤더(vN)·트리·변경 이력을 함께 다시 읽는다.
                setWritten((n) => n + 1);
              }}
              onDelete={() => setDeleting("field")}
            />
          ) : (
            <section className="app-card" aria-label="필드 상세">
              <h3>필드 상세</h3>
              <p className="app-muted">{tab === "structure" ? "트리나 그래프에서 필드를 선택하세요." : "구조 보기에서 필드를 선택하세요."}</p>
            </section>
          )}
        </div>
      </div>
      {dialog && (
        <SchemaEditor
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaved={(schema) => {
            setDialog(null);
            notify(`${schemaLabel({ schema_name: schema.schema_name, rev: schema.current_rev })} 저장됨`);
            setWritten((n) => n + 1);
            selectSchema(schema.schema_key);
          }}
        />
      )}
      {deleting === "schema" && detail.data && (
        <DeleteDialog
          label="스키마 삭제"
          message={`'${detail.data.schema_name}'과(와) 필드 ${detail.data.field_count}개를 지웁니다. 되돌릴 수 없습니다.`}
          busyLabel="스키마를 지우는 중…"
          onCancel={() => setDeleting("")}
          onShowBlocker={() => {
            setDeleting("");
            go({ tab: "profiles", field_filter: "" });
          }}
          onConfirm={async () => {
            const result = await api<SchemaDeleteResult>("/schemas/" + encoded, undefined, { method: "DELETE" });
            setDeleting("");
            notify(`'${result.schema_name || detail.data!.schema_name}' 스키마를 지웠습니다.`);
            setRemoved(key);
            setWritten((n) => n + 1);
            selectSchema(all.find((s) => s.schema_key !== key)?.schema_key || "");
          }}
        />
      )}
      {deleting === "field" && key && fieldKey && (
        <DeleteDialog
          label="필드 삭제"
          message={`'${names.get(fieldKey) || fieldKey}' 필드를 지운 새 리비전을 저장합니다.`}
          busyLabel="새 리비전을 저장하는 중…"
          onCancel={() => setDeleting("")}
          onShowBlocker={(blocker) => {
            setDeleting("");
            // 자식이 있어 막혔으면 트리에서 첫 하위 필드를 선택해 보여 주고, 그 밖에는 사용 프로파일 목록으로 보낸다.
            if (blocker.code === CHILDREN_CODE) {
              const child = blocker.detail?.children?.[0]?.field_key;
              if (child) go({ field_key: child, field: "" });
            } else go({ tab: "profiles", field_filter: fieldKey });
          }}
          onConfirm={async () => {
            const result = await api<FieldDeleteResult>(`/schemas/${encoded}/fields/${encodeURIComponent(fieldKey)}`, undefined, { method: "DELETE" });
            setDeleting("");
            notify(`'${result.name || names.get(fieldKey) || fieldKey}' 필드를 지웠습니다 · v${result.current_rev}`);
            setWritten((n) => n + 1);
            go({ field_key: "", field: "" });
          }}
        />
      )}
      {addingField && key && (
        <FieldCreateDialog
          schemaKey={key}
          nodes={parentChoices}
          parentKey={fieldKey || undefined}
          onClose={() => setAddingField(false)}
          onCreated={(field) => {
            setAddingField(false);
            notify(`${field.name} 필드 저장됨`);
            setWritten((n) => n + 1);
            go({ field_key: field.field_key, field: "" });
          }}
        />
      )}
    </>
  );
}
