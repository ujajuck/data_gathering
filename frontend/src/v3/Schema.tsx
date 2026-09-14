// 파싱 스키마 화면(§7 Schema, ui-development-spec §5): 3열 — 좌 스키마 목록(GET /schemas, 검색 250ms 클라이언트 필터, '새 스키마' 가져오기)
// / 중앙 상세(?schema=): 헤더(이름 vN · 상태) + 탭 `구조 보기 · 사용 프로파일 (N) · 연관 문서 (N) · 변경 이력`; 구조 보기 안에서만
// [트리 보기] [그래프 보기] 토글(?view=tree|graph) / 우 필드 상세(?field_key=). 진입 호출 = /schemas · /schemas/{key} · /schemas/{key}/tree (≤3);
// 그래프는 그래프 보기일 때만, 필드 상세는 선택 시. 탭의 ?field_filter=는 필드 상세의 'N개 보기 ›'가 건다.
import { useMemo, useState } from "react";
import { State, schemaLabel, useData, useDebounced, useNavigation, useToast } from "./client";
import type { Page, SchemaDetail, SchemaGraph as SchemaGraphData, SchemaRow, SchemaTree as SchemaTreeData } from "./types";
import { Chip, Heading, Tabs } from "./ui";
import SchemaTree, { flattenTree } from "./SchemaTree";
import SchemaGraph from "./SchemaGraph";
import FieldDetail from "./FieldDetail";
import SchemaImport from "./SchemaImport";
import type { SchemaImportMode } from "./SchemaImport";
import { FieldFilterBar, SchemaDocumentsTab, SchemaHistoryTab, SchemaProfilesTab } from "./SchemaTabs";

export type SchemaTab = "structure" | "profiles" | "documents" | "history";
const TABS: SchemaTab[] = ["structure", "profiles", "documents", "history"];
export type StructureView = "tree" | "graph";

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
  const [dialog, setDialog] = useState<SchemaImportMode | null>(null);
  const [written, setWritten] = useState(0);
  const version = refresh + written;

  const schemas = useData<Page<SchemaRow>>("/schemas", version);
  const all = schemas.data?.items ?? [];
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
  const names = useMemo(() => new Map(flattenTree(tree.data?.nodes ?? []).map((item) => [item.node.field_key, item.node.name])), [tree.data]);
  const selectField = (field_key: string) => go({ field_key, field: "" });
  const selectSchema = (schema_key: string) => go({ schema: schema_key, field_key: "", field: "", field_filter: "" });
  const status = schemaStatus(detail.data?.status);
  const schemaName = detail.data?.schema_name || tree.data?.schema_name || key;

  return (
    <>
      <div inert={dialog ? true : undefined}>
        <Heading
          title="파싱 스키마"
          description="공통 데이터 구조를 트리 또는 그래프로 확인하고, 파싱 프로파일과 실제 문서까지 추적합니다."
          actions={
            <button type="button" className="primary" onClick={() => setDialog({ kind: "new" })}>
              새 스키마
            </button>
          }
        />
        <div className="v3-split wide-right">
          <section className="v3-card" aria-label="스키마 목록">
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
              <div className="v3-list v3-side-list" aria-label="파싱 스키마">
                {filtered.map((s) => (
                  <button
                    key={s.schema_key}
                    type="button"
                    className={"v3-list-item" + (s.schema_key === key ? " selected" : "")}
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

          <section className="v3-card" aria-label="스키마 상세">
            {!key && <State resource={detail} isEmpty={!schemas.loading} empty="왼쪽에서 파싱 스키마를 선택하세요." />}
            {key && <State resource={detail} isEmpty={false} />}
            {detail.data && (
              <>
                <div className="v3-card-head">
                  <h2>
                    {schemaLabel({ schema_name: detail.data.schema_name, rev: detail.data.current_rev })} <Chip kind={status.kind}>{status.label}</Chip>
                  </h2>
                  <span className="v3-muted v3-small">
                    필드 {detail.data.field_count} · 프로파일 {detail.data.profile_count} · 문서 {detail.data.document_count}
                  </span>
                </div>
                {detail.data.description && <p className="v3-muted v3-small">{detail.data.description}</p>}
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
                  <div className="v3-stack" role="tabpanel" aria-label="구조 보기">
                    <div className="v3-toolbar">
                      <div className="v3-segment" role="group" aria-label="구조 보기 방식">
                        <button type="button" aria-pressed={view === "tree"} onClick={() => go({ view: "" })}>
                          트리 보기
                        </button>
                        <button type="button" aria-pressed={view === "graph"} onClick={() => go({ view: "graph" })}>
                          그래프 보기
                        </button>
                      </div>
                      {fieldKey && (
                        <button type="button" className="small v3-toolbar-end" onClick={() => go({ field_key: "", field: "" })}>
                          선택 해제
                        </button>
                      )}
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
                    <SchemaHistoryTab
                      schemaKey={key}
                      version={version}
                      currentRev={detail.data.current_rev}
                      onNewRevision={() => setDialog({ kind: "revision", schemaKey: key, schemaName: detail.data!.schema_name })}
                    />
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
            />
          ) : (
            <section className="v3-card" aria-label="필드 상세">
              <h3>필드 상세</h3>
              <p className="v3-muted">{tab === "structure" ? "트리나 그래프에서 필드를 선택하세요." : "구조 보기에서 필드를 선택하세요."}</p>
            </section>
          )}
        </div>
      </div>
      {dialog && (
        <SchemaImport
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
    </>
  );
}
