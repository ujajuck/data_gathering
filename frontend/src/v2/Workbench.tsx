import { useEffect, useState } from "react";
import {
  api,
  downloadFile,
  JobBar,
  NavigationContext,
  useDraft,
  Pager,
  setToken,
  State,
  TaskProvider,
  useData,
  useNavigation,
  usePage,
  useRoute,
  useTasks,
} from "./client";
import type { Row } from "./client";
import Source from "./Source";
import Database from "./Database";
import { ReviewQueue } from "./Review";
import { TemplatePresets } from "./Presets";
import ConceptEditor from "./ConceptEditor";
import DomainGraph from "./DomainGraph";
import type { Graph, GraphNode } from "./DomainGraph";
import Recrawl from "./Recrawl";
import "./workbench.css";
import "../product.css";
import { PRODUCT_NAME, PRODUCT_DESCRIPTION, PRODUCT_STEPS } from "../product";

const tabs = PRODUCT_STEPS.map((s) => [s.v2, s.label]);
export default function Workbench() {
  const navigation = useRoute();
  const [token, editToken] = useState("");
  const status = useData("/status");
  const current = navigation.route.tab || "documents";
  return (
    <NavigationContext.Provider value={navigation}>
      <TaskProvider>
        <div className="v2">
          <header className="v2-header">
            <a className="v2-brand" href="?v2=1">
              <span>
                <strong>{PRODUCT_NAME}</strong>
                <small>{PRODUCT_DESCRIPTION}</small>
              </span>
            </a>
            <nav className="v2-nav" aria-label="작업 단계">
              {tabs.map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => navigation.go({ tab: id })}
                  aria-current={current === id ? "page" : undefined}
                >
                  {label}
                </button>
              ))}
            </nav>
            <a href="?v1=1" title="이전 kg.db 데이터를 여는 호환 화면입니다.">
              이전 데이터 ↗
            </a>
          </header>
          <JobBar />
          {status.error ? (
            <main className="v2-main">
              <section className="v2-card">
                <h1>작업 공간 연결</h1>
                <p className="v2-error">{status.error}</p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setToken(token);
                    status.reload();
                  }}
                >
                  <label>
                    서버 접근 토큰
                    <input
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => editToken(e.target.value)}
                    />
                  </label>
                  <button className="primary">연결</button>
                </form>
              </section>
            </main>
          ) : status.loading ? (
            <p className="v2-main">작업 공간을 불러오는 중…</p>
          ) : (
            <main className="v2-main" key={current}>
              {current === "documents" ? (
                <Documents />
              ) : current === "kg" ? (
                <Knowledge />
              ) : current === "source" ? (
                <Source />
              ) : current === "templates" ? (
                <Templates />
              ) : (
                <Database />
              )}
            </main>
          )}
          <footer>
            원본 버전 · 템플릿 버전 · 검수 이력을 고정하여 출처를 보존합니다.
          </footer>
        </div>
      </TaskProvider>
    </NavigationContext.Provider>
  );
}
export function Heading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="v2-heading">
      <div className="v2-eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
export function Documents() {
  const { route, go, refresh, changed } = useNavigation();
  const tasks = useTasks();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useDraft<Record<string, string>>(
    "document-filters",
    {
      author: "",
      date_from: "",
      date_to: "",
      access_status: "",
      extraction_status: "",
      template: "",
      sort: "name",
      direction: "asc",
    },
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
  const [directory, setDirectory] = useState("");
  const sources = usePage(
    "/sources?directory=" + encodeURIComponent(directory),
  );
  const [refs, setRefs] = useState("");
  const [provider, setProvider] = useState("local-xlsx");
  const [error, setError] = useState("");
  return (
    <>
      <Heading
        eyebrow="01 / DOCUMENTS"
        title="원본에서 시작하세요"
        description="원본을 등록하고 문서 버전과 시트를 선택합니다. 등록은 문서 내용을 변경하지 않습니다."
      />
      <div className="v2-grid two">
        <section className="v2-card">
          <div className="v2-card-head">
            <h2>등록 문서</h2>
            <span className="v2-badge">현재 버전</span>
          </div>
          <form
            className="v2-inline"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query);
            }}
          >
            <input
              aria-label="문서 검색"
              placeholder="문서명 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button>검색</button>
          </form>
          <details className="v2-details">
            <summary>문서 필터 · 정렬</summary>
            <div className="v2-grid two">
              {[
                ["author", "작성자"],
                ["template", "적용 템플릿"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={filters[key]}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
              {[
                ["date_from", "작성일 시작"],
                ["date_to", "작성일 종료"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="date"
                    value={filters[key]}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, [key]: e.target.value }))
                    }
                  />
                </label>
              ))}
              <label>
                접근 상태
                <select
                  value={filters.access_status}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, access_status: e.target.value }))
                  }
                >
                  <option value="">전체</option>
                  <option value="allowed">접근 가능</option>
                  <option value="denied">접근 불가</option>
                  <option value="expired">확인 만료</option>
                  <option value="unknown">미확인</option>
                </select>
              </label>
              <label>
                추출 상태
                <select
                  value={filters.extraction_status}
                  onChange={(e) =>
                    setFilters((f) => ({
                      ...f,
                      extraction_status: e.target.value,
                    }))
                  }
                >
                  <option value="">전체</option>
                  <option value="unassigned">미배정</option>
                  <option value="review">검수 필요</option>
                  <option value="pending">추출 필요</option>
                  <option value="published">발행됨</option>
                  <option value="failed">실패</option>
                </select>
              </label>
              <label>
                정렬 기준
                <select
                  value={filters.sort}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, sort: e.target.value }))
                  }
                >
                  <option value="name">문서명</option>
                  <option value="author">작성자</option>
                  <option value="authored_at">작성일</option>
                  <option value="registered_at">등록일</option>
                </select>
              </label>
              <label>
                정렬 방향
                <select
                  value={filters.direction}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, direction: e.target.value }))
                  }
                >
                  <option value="asc">오름차순</option>
                  <option value="desc">내림차순</option>
                </select>
              </label>
            </div>
            <p className="v2-muted">
              접근 상태는 최근 확인 결과입니다. 원본을 열거나 추출할 때 권한을
              다시 확인합니다.
            </p>
          </details>
          <State
            resource={documents}
            empty="원본 폴더의 파일을 선택해 첫 문서를 등록하세요."
          />
          <div className="v2-list">
            {documents.data?.items.map((doc) => (
              <button
                className={
                  "v2-list-item " +
                  (route.document === doc.document_id ? "selected" : "")
                }
                key={doc.document_id}
                onClick={() =>
                  go({
                    document: doc.document_id,
                    version: doc.current_version_id,
                    sheet: "",
                    application: "",
                    mapping: "",
                    series: "",
                    item: "",
                  })
                }
              >
                <span className="v2-file-icon">X</span>
                <span>
                  <strong>{doc.display_name}</strong>
                  <small>
                    {doc.provider} · {doc.file_type.toUpperCase()}
                  </small>
                  <small>
                    {doc.author || "작성자 미상"} ·{" "}
                    {doc.authored_at?.slice(0, 10) || "작성일 미상"} ·{" "}
                    {
                      {
                        allowed: "접근 가능",
                        denied: "접근 불가",
                        expired: "확인 만료",
                        unknown: "접근 미확인",
                      }[doc.access_status as string]
                    }{" "}
                    ·{" "}
                    {
                      {
                        unassigned: "미배정",
                        review: "검수 필요",
                        pending: "추출 필요",
                        published: "발행됨",
                        failed: "실패",
                      }[doc.extraction_status as string]
                    }
                  </small>
                </span>
                <span>→</span>
              </button>
            ))}
          </div>
          <Pager page={documents} />
        </section>
        <section className="v2-card">
          <h2>원본 등록</h2>
          <p className="v2-muted">
            서버의 원본 폴더에서 선택하거나 보안 제공자의 원본 참조를
            입력하세요.
          </p>
          <div className="v2-inline">
            <code>/{directory}</code>
            {directory && (
              <button
                onClick={() =>
                  setDirectory(directory.split("/").slice(0, -1).join("/"))
                }
              >
                상위 폴더
              </button>
            )}
          </div>
          <div className="v2-source-files">
            <State
              resource={sources}
              empty="폴더에 XLSX가 없습니다. 원본 참조를 직접 입력할 수 있습니다."
            />
            {sources.data?.items.map((file) => (
              <button
                key={file.name}
                onClick={() =>
                  file.directory
                    ? setDirectory(file.source_ref)
                    : setRefs((previous) =>
                        [
                          ...new Set([
                            ...previous.split("\n").filter(Boolean),
                            file.source_ref,
                          ]),
                        ].join("\n"),
                      )
                }
              >
                {file.directory ? "▸" : "+"} {file.name}
              </button>
            ))}
          </div>
          <Pager page={sources} />
          <label>
            읽기 제공자
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="local-xlsx">일반 XLSX (간략 보기)</option>
              <option value="protected-reader">보안 원본 어댑터</option>
            </select>
          </label>
          {provider !== "local-xlsx" && (
            <p className="v2-note">
              서버에 승인된 DRM 읽기·렌더 어댑터가 연결되어 있어야 합니다.
            </p>
          )}
          <label>
            원본 참조 · 한 줄에 하나, 최대 100개
            <textarea
              rows={3}
              value={refs}
              onChange={(e) => setRefs(e.target.value)}
              placeholder="sample.xlsx"
            />
          </label>
          <p className="v2-error">{error}</p>
          <button
            className="primary"
            disabled={tasks.busy || !refs.trim()}
            onClick={() => {
              setError("");
              tasks.run(
                "/documents/register",
                {
                  source_refs: refs
                    .split("\n")
                    .map((v) => v.trim())
                    .filter(Boolean),
                  provider,
                },
                (result) => {
                  changed();
                  const doc = result.documents?.[0];
                  if (doc)
                    go({
                      document: doc.document_id,
                      version: doc.version_id,
                      sheet: "",
                      application: "",
                      mapping: "",
                    });
                },
              );
            }}
          >
            문서 등록
          </button>
        </section>
      </div>
      {route.document && <DocumentDetail key={route.document + refresh} />}
      <ReviewQueue />
    </>
  );
}
function DocumentDetail() {
  const { route, go } = useNavigation();
  const versions = usePage("/documents/" + route.document + "/versions");
  const sheets = usePage(
    route.version ? "/versions/" + route.version + "/sheets" : null,
  );
  return (
    <section className="v2-card v2-space">
      <div className="v2-card-head">
        <h2>문서 버전 · 시트</h2>
        {route.version && (
          <button onClick={() => go({ tab: "source" })}>
            원본 · 검수 열기 →
          </button>
        )}
      </div>
      <div className="v2-grid two">
        <div>
          <h3>등록 버전</h3>
          <State resource={versions} />
          <div className="v2-list">
            {versions.data?.items.map((v) => (
              <button
                className={
                  "v2-list-item " +
                  (v.document_version_id === route.version ? "selected" : "")
                }
                key={v.document_version_id}
                onClick={() =>
                  go({
                    version: v.document_version_id,
                    sheet: "",
                    application: "",
                    mapping: "",
                    series: "",
                    item: "",
                  })
                }
              >
                <span>
                  <strong>
                    {v.filename} · v{v.revision_no}
                  </strong>
                  <small>
                    {v.captured_at} · {v.author || "작성자 미상"}
                  </small>
                </span>
              </button>
            ))}
          </div>
          <Pager page={versions} />
        </div>
        <div>
          <h3>시트 선택</h3>
          <State resource={sheets} />
          {sheets.data?.items.map((s) => (
            <button
              className="v2-chip"
              key={s.sheet_id}
              onClick={() => go({ tab: "source", sheet: s.sheet_id })}
            >
              {s.name} · {s.estimated_rows || "?"}행
            </button>
          ))}
          <Pager page={sheets} />
        </div>
      </div>
      <AssignTemplate />
    </section>
  );
}
export function AssignTemplate() {
  const { route, go, changed } = useNavigation();
  const templates = usePage("/templates");
  const sheets = usePage(
    route.version ? "/versions/" + route.version + "/sheets" : null,
  );
  const [selected, setSelected] = useState("");
  const detail = useData(selected ? "/template-versions/" + selected : null);
  const [bindings, setBindings] = useState<Record<string, string[]>>({});
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function assign() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/applications", {
        version_id: route.version,
        template_version_id: selected,
        bindings,
        approved,
      });
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
  return (
    <details className="v2-details">
      <summary>+ 이 문서 버전에 템플릿 연결</summary>
      <p>
        같은 시트·위치에도 여러 템플릿을 연결할 수 있습니다. 시트 역할마다 실제
        시트를 선택하세요.
      </p>
      <label>
        템플릿
        <select
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setBindings({});
            setApproved(false);
          }}
        >
          <option value="">템플릿 선택</option>
          {templates.data?.items.map((t) => (
            <option value={t.template_version_id} key={t.template_id}>
              {t.name} · v{t.revision_no}
            </option>
          ))}
        </select>
      </label>
      <State
        resource={templates}
        empty="템플릿 탭에서 먼저 템플릿을 만드세요."
      />
      <Pager page={templates} />
      <State resource={detail} />
      {detail.data &&
        Object.entries(detail.data.definition.sheet_roles).map(
          ([role, value]) => (
            <div className="v2-binding" key={role}>
              <label>
                {role} · {(value as Row).cardinality || "one"}
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value)
                      setBindings((b) => ({
                        ...b,
                        [role]:
                          (value as Row).cardinality === "many"
                            ? [...new Set([...(b[role] || []), e.target.value])]
                            : [e.target.value],
                      }));
                  }}
                >
                  <option value="">시트 연결</option>
                  {sheets.data?.items.map((s) => (
                    <option value={s.sheet_id} key={s.sheet_id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {(bindings[role] || []).map((id) => (
                <button
                  className="v2-chip"
                  key={id}
                  onClick={() =>
                    setBindings((b) => ({
                      ...b,
                      [role]: b[role].filter((x) => x !== id),
                    }))
                  }
                >
                  {sheets.data?.items.find((s) => s.sheet_id === id)?.name ||
                    id.slice(0, 8)}{" "}
                  ×
                </button>
              ))}
            </div>
          ),
        )}
      {selected && (
        <>
          <Pager page={sheets} />
          <label className="v2-check">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            선택한 시트에서 키·값 영역과 연결 개념을 확인했습니다
          </label>
          <button
            className="primary"
            disabled={busy || !route.version}
            onClick={assign}
          >
            {approved ? "승인하여 연결" : "검수 대기로 연결"}
          </button>
        </>
      )}
      <p className="v2-error" role="alert">
        {error}
      </p>
    </details>
  );
}
export function Knowledge() {
  const { route, go, refresh, changed } = useNavigation();
  const revisions = usePage("/kg/revisions?r=" + refresh);
  const kg = route.kg || revisions.data?.items.at(-1)?.kg_revision_id || "";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const concepts = usePage(
    kg ? "/kg/" + kg + "/concepts?q=" + encodeURIComponent(search) : null,
  );
  const [definition, setDefinition] = useState(
    '{\n  "concepts": [\n    {"concept_id": "process_temperature", "name": "공정온도", "level": 1, "aliases": ["공정 온도", "Process Temp"], "canonical_unit": "°C"}\n  ],\n  "relations": []\n}',
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const relations = usePage(
    kg && route.concept
      ? "/kg/" +
          kg +
          "/concepts/" +
          encodeURIComponent(route.concept) +
          "/relations"
      : null,
  );
  const sources = usePage(
    kg && route.concept
      ? "/series?kg_revision_id=" +
          kg +
          "&concept_id=" +
          encodeURIComponent(route.concept)
      : null,
  );
  const graph = useData(kg ? "/kg/" + kg + "/graph" : null);
  const [view, setView] = useState<"graph" | "list">("graph");
  const [zoom, setZoom] = useState(1);
  const rootFilter = route.root || "";
  const selectedOnPage = concepts.data?.items.find(
    (c) => c.concept_id === route.concept,
  );
  // 그래프에서 고른 개념이 현재 목록 페이지에 없으면 편집기를 위해 한 번만 보조 조회한다.
  const lookup = useData(
    kg && route.concept && concepts.data && !selectedOnPage
      ? "/kg/" + kg + "/concepts?q=" + encodeURIComponent(route.concept)
      : null,
  );
  const selected =
    selectedOnPage ||
    lookup.data?.items?.find((c: Row) => c.concept_id === route.concept);
  const graphData = graph.data as Graph | null;
  const rootName =
    graphData?.groups.find((g) => g.root_concept_id === rootFilter)?.name ||
    rootFilter;
  const filtered: GraphNode[] | null =
    rootFilter && graphData
      ? graphData.nodes
          .filter(
            (n) =>
              n.root === rootFilter &&
              (!search ||
                n.name.includes(search) ||
                n.concept_id.includes(search)),
          )
          .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      : null;
  async function save(current = false) {
    setBusy(true);
    setError("");
    try {
      const r = await api(
        current ? "/kg/import-current" : "/kg/import",
        current ? {} : JSON.parse(definition),
      );
      changed();
      go({ kg: r.kg_revision_id, concept: "", root: "" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="02 / DOMAIN KNOWLEDGE"
        title="표현은 달라도, 의미는 하나로"
        description="사람이 정의한 도메인 KG를 버전으로 관리합니다. 같은 동의어가 여러 개념에 속하면 검수자가 문맥을 보고 연결합니다."
      />
      <div
        className={
          "v2-grid " + (view === "graph" ? "three v2-kg-layout" : "two")
        }
      >
        <section className="v2-card" aria-label="도메인 개념">
          <div className="v2-card-head">
            <h2>도메인 개념</h2>
            <div className="v2-segment" role="group" aria-label="보기 전환">
              <button
                aria-pressed={view === "graph"}
                onClick={() => setView("graph")}
              >
                그래프
              </button>
              <button
                aria-pressed={view === "list"}
                onClick={() => setView("list")}
              >
                목록
              </button>
            </div>
          </div>
          <label>
            KG 버전
            <select
              value={kg}
              onChange={(e) =>
                go({ kg: e.target.value, concept: "", root: "" })
              }
            >
              <option value="">KG 선택</option>
              {revisions.data?.items.map((k) => (
                <option key={k.kg_revision_id} value={k.kg_revision_id}>
                  v{k.revision_no} · {k.created_at.slice(0, 10)}
                </option>
              ))}
            </select>
          </label>
          <Pager page={revisions} />
          <form
            className="v2-inline"
            onSubmit={(e) => {
              e.preventDefault();
              setSearch(query);
            }}
          >
            <input
              aria-label="개념 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="개념명 · 동의어 검색"
            />
            <button>검색</button>
          </form>
          {filtered ? (
            <>
              <p className="v2-chips">
                <span className="v2-chip">문서군 필터: {rootName}</span>
                <button className="v2-link" onClick={() => go({ root: "" })}>
                  필터 해제
                </button>
              </p>
              {filtered.length === 0 && (
                <p className="v2-empty">이 문서군에 해당하는 개념이 없습니다.</p>
              )}
              <div className="v2-list">
                {filtered.map((c) => (
                  <button
                    key={c.concept_id}
                    className={
                      "v2-list-item " +
                      (route.concept === c.concept_id ? "selected" : "")
                    }
                    onClick={() => go({ kg, concept: c.concept_id })}
                  >
                    <span className="v2-level">L{c.level}</span>
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {c.sources ? `현재 출처 ${c.sources}` : "미연결"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <State resource={concepts} />
              <div className="v2-list">
                {concepts.data?.items.map((c) => (
                  <button
                    key={c.concept_id}
                    className={
                      "v2-list-item " +
                      (route.concept === c.concept_id ? "selected" : "")
                    }
                    onClick={() => go({ kg, concept: c.concept_id })}
                  >
                    <span className="v2-level">L{c.level}</span>
                    <span>
                      <strong>{c.name}</strong>
                      <small>
                        {c.definition} · {c.canonical_unit || "단위 없음"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
              <Pager page={concepts} />
            </>
          )}
        </section>
        {view === "graph" && (
          <section className="v2-card v2-graph-card" aria-label="개념 그래프">
            <div className="v2-card-head">
              <div>
                <h2>전체 개념 · 문서군 Coverage</h2>
                <p className="v2-muted">
                  반투명 영역은 각 문서군(L1)이 어떤 개념을 덮는지, 숫자는 현재
                  문서 버전에서 발행된 추출 출처 수입니다.
                </p>
              </div>
              <div className="v2-inline">
                <button
                  aria-label="그래프 축소"
                  onClick={() =>
                    setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 4) / 4))
                  }
                >
                  −
                </button>
                <button aria-label="원래 크기로" onClick={() => setZoom(1)}>
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  aria-label="그래프 확대"
                  onClick={() =>
                    setZoom((z) => Math.min(2.5, Math.round((z + 0.25) * 4) / 4))
                  }
                >
                  ＋
                </button>
              </div>
            </div>
            <State
              resource={{
                ...graph,
                data: graphData && { items: graphData.nodes },
              }}
              empty="이 KG 버전에 표시할 개념이 없습니다."
            />
            {graphData?.truncated && (
              <p className="v2-note">
                개념이 {(graphData.node_cap || 2000).toLocaleString()}개를 넘어
                일부만 표시합니다. 나머지는 왼쪽 검색으로 찾으세요.
              </p>
            )}
            {graphData && graphData.nodes.length > 0 && (
              <div className="v2-graph-wrap">
                <DomainGraph
                  graph={graphData}
                  selectedRoot={rootFilter}
                  selectedConcept={route.concept || ""}
                  zoom={zoom}
                  onSelectNode={(id) => go({ kg, concept: id })}
                  onSelectRoot={(id) =>
                    go({ root: rootFilter === id ? "" : id })
                  }
                />
              </div>
            )}
          </section>
        )}
        <section className="v2-card">
          <h2>{route.concept || "개념을 선택하세요"}</h2>
          {selected && (
            <ConceptEditor
              key={kg + route.concept}
              kg={kg}
              concept={selected}
            />
          )}
          <h3>연결 관계</h3>
          <State resource={relations} empty="등록된 관계가 없습니다." />
          {relations.data?.items.map((edge, i) => (
            <button
              className="v2-relation"
              key={i}
              onClick={() =>
                go({
                  concept:
                    edge.from_concept_id === route.concept
                      ? edge.to_concept_id
                      : edge.from_concept_id,
                })
              }
            >
              {edge.from_concept_id} <b>{edge.relation_type}</b>{" "}
              {edge.to_concept_id} →
            </button>
          ))}
          {route.concept && <Pager page={relations} />}
          <h3>현재 추출 출처</h3>
          <State
            resource={sources}
            empty="이 개념으로 발행된 현재 추출이 없습니다."
          />
          {sources.data?.items.map((s) => (
            <button
              key={s.series_id}
              className="v2-list-item"
              onClick={() =>
                go({
                  tab: "source",
                  version: s.document_version_id,
                  application: s.application_id,
                  mapping: s.mapping_revision_id,
                  series: s.series_id,
                  sheet: "",
                  item: "",
                })
              }
            >
              <span>
                <strong>{s.observed_key || s.rule_key}</strong>
                <small>
                  {s.cardinality} · {s.axis}
                </small>
              </span>
              <span>원본 →</span>
            </button>
          ))}
          {route.concept && <Pager page={sources} />}
        </section>
      </div>
      <details className="v2-details v2-card v2-space">
        <summary>사람이 작성한 KG 등록 · 새 버전 만들기</summary>
        <p>
          기존 도메인 정의를 가져오거나 전체 KG JSON을 등록하세요. 이전 버전과
          이미 연결한 템플릿은 보존됩니다.
        </p>
        <button disabled={busy} onClick={() => save(true)}>
          현재 워크스페이스의 수동 KG 가져오기
        </button>
        <label>
          KG JSON
          <textarea
            className="v2-code"
            rows={12}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
          />
        </label>
        <button className="primary" disabled={busy} onClick={() => save()}>
          새 KG 버전 등록
        </button>
        <p className="v2-error">{error}</p>
      </details>
    </>
  );
}
export function templateExample(kg: string) {
  return {
    kg_revision_id: kg,
    sheet_roles: { main: { cardinality: "one" } },
    rules: [
      {
        rule_key: "process_temperature",
        concept_id: "process_temperature",
        selector: {
          key: { areas: [{ sheet_role: "main", range: "B2:C2" }] },
          value: {
            areas: [{ sheet_role: "main", range: "B3:C20" }],
            cardinality: "list",
            axis: "down",
            element_layout: "one_per_row",
            stop: { kind: "explicit_areas", max_items: 10000 },
          },
        },
        record_spec: { scope: ["process-table"], key: "physical_row" },
        value_spec: {
          type: "decimal",
          unit: "°C",
          formula_policy: "cached_only",
        },
      },
    ],
  };
}
export function Templates() {
  const { route, refresh, changed } = useNavigation();
  const templates = usePage("/templates?r=" + refresh);
  const revisions = usePage("/kg/revisions");
  const [name, setName] = useDraft("template-name", "공정온도");
  const [templateId, setTemplateId] = useDraft("template-id", "");
  const [kg, setKg] = useDraft("template-kg", route.kg || "");
  const [text, setText] = useDraft(
    "template-json",
    JSON.stringify(templateExample(route.kg || ""), null, 2),
  );
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useDraft(
    "template-selected",
    "",
  );
  const versions = usePage(
    selectedTemplate ? "/templates/" + selectedTemplate + "/versions" : null,
  );
  const [exportId, setExportId] = useDraft("template-export-version", "");
  async function edit(id: string, label: string) {
    setError("");
    try {
      const v = await api("/template-versions/" + id);
      setExportId(id);
      setText(JSON.stringify(v.definition, null, 2));
      setTemplateId(v.template_id);
      setName(label);
      setKg(v.kg_revision_id);
      setMessage(
        "선택한 버전을 복사했습니다. 저장하면 새 버전이 만들어집니다.",
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const definition = JSON.parse(text);
      definition.kg_revision_id = kg || definition.kg_revision_id;
      const r = await api("/templates", {
        name,
        definition,
        ...(templateId ? { template_id: templateId } : {}),
      });
      changed();
      setMessage(
        "템플릿 v" +
          r.revision_no +
          "를 저장했습니다. 문서 탭에서 시트를 연결하세요.",
      );
      setTemplateId(r.template_id);
      setExportId(r.template_version_id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="05 / TEMPLATES"
        title="양식의 차이를 규칙으로"
        description="템플릿은 재사용할 추출 규칙입니다. 한 문서의 위치 수정은 원본 · 검수에서, 공통 규칙 변경은 새 템플릿 버전으로 저장합니다."
      />
      <div className="v2-grid template-layout">
        <section className="v2-card">
          <div className="v2-card-head">
            <h2>템플릿 목록</h2>
            <button
              onClick={() => {
                setTemplateId("");
                setExportId("");
                setSelectedTemplate("");
                setText(JSON.stringify(templateExample(kg), null, 2));
                setMessage("새 템플릿을 작성합니다.");
              }}
            >
              + 새 템플릿
            </button>
          </div>
          <State resource={templates} />
          {templates.data?.items.map((t) => (
            <button
              className={
                "v2-list-item " +
                (templateId === t.template_id ? "selected" : "")
              }
              key={t.template_id}
              onClick={() => {
                setSelectedTemplate(t.template_id);
                edit(t.template_version_id, t.name);
              }}
            >
              <span>
                <strong>{t.name}</strong>
                <small>v{t.revision_no} · JSON</small>
              </span>
              <span>편집 →</span>
            </button>
          ))}
          <Pager page={templates} />
          {selectedTemplate && (
            <>
              <h3>이전 버전</h3>
              {versions.data?.items.map((v) => (
                <button
                  className="v2-chip"
                  key={v.template_version_id}
                  onClick={() => edit(v.template_version_id, name)}
                >
                  v{v.revision_no}
                </button>
              ))}
              <Pager page={versions} />
            </>
          )}
        </section>
        <section className="v2-card">
          <h2>{templateId ? "새 버전 작성" : "템플릿 작성"}</h2>
          {exportId && (
            <button
              onClick={() =>
                downloadFile(
                  `/template-versions/${exportId}/download`,
                  `template-${exportId}.json`,
                ).catch((e) => setError(e.message))
              }
            >
              선택한 버전 JSON 내보내기
            </button>
          )}
          {exportId && <Recrawl key={exportId} templateVersionId={exportId} />}
          <div className="v2-grid two">
            <label>
              템플릿 이름
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              도메인 KG 버전
              <select value={kg} onChange={(e) => setKg(e.target.value)}>
                <option value="">선택하세요</option>
                {revisions.data?.items.map((k) => (
                  <option key={k.kg_revision_id} value={k.kg_revision_id}>
                    KG v{k.revision_no}
                  </option>
                ))}
              </select>
              <Pager page={revisions} />
            </label>
          </div>
          <p className="v2-note">
            여러 시트는 sheet_roles에 선언합니다. key/value의 areas 배열은
            떨어진 영역을 순서대로 읽습니다. 값 목록은 down/right, 행렬은
            row_major/column_major로 지정합니다.
          </p>
          <label>
            규칙 JSON
            <textarea
              rows={24}
              className="v2-code"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <TemplatePresets source={text} onChange={setText} />
          <button className="primary" disabled={busy} onClick={save}>
            검증하고 {templateId ? "새 버전 저장" : "템플릿 저장"}
          </button>
          <p className="v2-error" role="alert">
            {error}
          </p>
          <p className="v2-success" role="status">
            {message}
          </p>
        </section>
      </div>
    </>
  );
}
