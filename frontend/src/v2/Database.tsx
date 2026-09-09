import { useState } from "react";
import {
  api,
  download,
  useDraft,
  Pager,
  State,
  range,
  useData,
  useNavigation,
  usePage,
  useTasks,
} from "./client";
import type { Row } from "./client";
import { Heading } from "./Workbench";

// Count has its own output type and no measurement unit. Keep the original
// field metadata while counting so changing modes cannot corrupt that field.
function fieldForMode(field: Row, mode: string, aggregate = field.aggregate) {
  const measurementType = field.measurement_type ?? field.target_type;
  const measurementUnit = Object.hasOwn(field, "measurement_unit")
    ? field.measurement_unit
    : field.target_unit;
  const { measurement_type, measurement_unit, ...base } = field;
  const counting = mode === "aggregate" && aggregate === "count";
  return {
    ...base,
    aggregate,
    target_type: counting ? "decimal" : measurementType,
    target_unit: counting ? null : measurementUnit,
    ...(counting
      ? { measurement_type: measurementType, measurement_unit: measurementUnit }
      : {}),
  };
}

export default function Database() {
  const { route, go, refresh, changed } = useNavigation();
  const tasks = useTasks();
  const revisions = usePage("/kg/revisions");
  const kg = route.kg || revisions.data?.items.at(-1)?.kg_revision_id || "";
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState("");
  const concepts = usePage(
    kg ? "/kg/" + kg + "/concepts?q=" + encodeURIComponent(search) : null,
  );
  const sources = usePage(
    kg && route.concept
      ? "/series?kg_revision_id=" +
          kg +
          "&concept_id=" +
          encodeURIComponent(route.concept)
      : null,
  );
  const [fields, setFields] = useDraft<Row[]>("database-fields:" + kg, []),
    [name, setName] = useDraft("database-name", "사용자 맞춤 DB"),
    [mode, setMode] = useDraft("database-mode:" + kg, "record_scope"),
    [confirmed, setConfirmed] = useDraft("database-confirmed:" + kg, false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [json, setJson] = useState("");
  const projects = usePage("/integrations?r=" + refresh),
    builds = usePage(
      route.project
        ? "/builds?integration_version_id=" + route.project + "&r=" + refresh
        : null,
    ),
    rows = usePage(route.build ? "/builds/" + route.build + "/rows" : null);
  const lineage = usePage(
      route.build && route.output_row && route.field
        ? "/builds/" +
            route.build +
            "/lineage?row_key=" +
            encodeURIComponent(route.output_row) +
            "&field_key=" +
            encodeURIComponent(route.field)
        : null,
    ),
    regions = usePage(
      route.lineage_item ? "/items/" + route.lineage_item + "/regions" : null,
    ),
    selectedItem = useData(
      route.lineage_item ? "/items/" + route.lineage_item : null,
    );
  const spec = {
    kg_revision_id: kg,
    row_mode: mode,
    business_key_confirmed: confirmed,
    fields,
  };
  async function add(source: Row) {
    setError("");
    try {
      const m = await api("/mappings/" + source.mapping_revision_id);
      const sample = await api(
        "/series/" + source.series_id + "/items?limit=1",
      );
      setFields((previous) => {
        const old = previous.find((f) => f.concept_id === source.concept_id),
          link = {
            application_id: source.application_id,
            rule_key: source.rule_key,
          };
        if (old) {
          if (
            old.sources.some(
              (s: Row) =>
                s.application_id === link.application_id &&
                s.rule_key === link.rule_key,
            )
          )
            return previous;
          return previous.map((f) =>
            f === old ? { ...f, sources: [...f.sources, link] } : f,
          );
        }
        return [
          ...previous,
          {
            field_key: "field_" + crypto.randomUUID().replaceAll("-", ""),
            output_name:
              concepts.data?.items.find(
                (c) => c.concept_id === source.concept_id,
              )?.name || source.concept_id,
            concept_id: source.concept_id,
            target_type: m.effective_spec.value_spec.type || "text",
            target_unit:
              sample.items[0]?.unit_normalized ||
              m.effective_spec.value_spec.unit ||
              null,
            aggregate: "sum",
            sources: [link],
          },
        ];
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const p = await api("/integrations", { name, spec });
      changed();
      go({
        project: p.integration_version_id,
        build: "",
        output_row: "",
        field: "",
        lineage_item: "",
      });
      await tasks.run(
        "/integrations/" + p.integration_version_id + "/build",
        {},
        (result) => {
          changed();
          go({
            project: result.integration_version_id,
            build: result.build_id,
          });
        },
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function focus(part: Row) {
    const item = selectedItem.data;
    if (item)
      go({
        tab: "source",
        version: part.document_version_id,
        sheet: part.sheet_id,
        row: String(part.r1),
        col: String(part.c1),
        application: item.application_id,
        mapping: item.mapping_revision_id,
        series: item.series_id,
        item: item.item_id,
        document: item.document_id,
      });
  }
  return (
    <>
      <Heading
        eyebrow="05 / CUSTOM DATABASE"
        title="필요한 정보로 나만의 DB를"
        description="개념별 추출 소스를 선택해 출력 필드를 구성합니다. 생성된 DB의 모든 값에서 기여한 원본 항목으로 돌아갈 수 있습니다."
      />
      <div className="v2-grid two">
        <section className="v2-card">
          <h2>1. 추출 소스 선택</h2>
          <label>
            KG 버전
            <select
              value={kg}
              disabled={fields.length > 0}
              onChange={(e) => go({ kg: e.target.value, concept: "" })}
            >
              <option value="">선택하세요</option>
              {revisions.data?.items.map((k) => (
                <option key={k.kg_revision_id} value={k.kg_revision_id}>
                  KG v{k.revision_no}
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
              aria-label="출력 개념 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="필요한 개념 검색"
            />
            <button>검색</button>
          </form>
          <State resource={concepts} />
          <div className="v2-chips">
            {concepts.data?.items.map((c) => (
              <button
                className={
                  "v2-chip " +
                  (route.concept === c.concept_id ? "selected" : "")
                }
                key={c.concept_id}
                onClick={() => go({ kg, concept: c.concept_id })}
              >
                {c.name}
              </button>
            ))}
          </div>
          <Pager page={concepts} />
          <h3>현재 발행된 소스</h3>
          <State
            resource={sources}
            empty="현재 발행 결과가 없습니다. 원본 · 검수에서 추출하세요."
          />
          {sources.data?.items.map((s) => (
            <div className="v2-list-item" key={s.series_id}>
              <span>
                <strong>{s.observed_key || s.rule_key}</strong>
                <small>
                  {s.application_id.slice(0, 8)} · {s.cardinality}
                </small>
              </span>
              <button onClick={() => add(s)}>필드에 추가</button>
            </div>
          ))}
          <Pager page={sources} />
        </section>
        <section className="v2-card">
          <h2>2. 출력 필드 · 행 결합</h2>
          <label>
            DB 이름
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {!fields.length && (
            <p className="v2-empty">왼쪽에서 추출 소스를 추가하세요.</p>
          )}
          {fields.map((field, i) => (
            <div className="v2-field" key={field.field_key}>
              <div className="v2-inline">
                <label>
                  출력 열 이름
                  <input
                    value={field.output_name}
                    onChange={(e) =>
                      setFields((fs) =>
                        fs.map((f, n) =>
                          n === i ? { ...f, output_name: e.target.value } : f,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  aria-label={`${field.output_name} 필드 삭제`}
                  onClick={() =>
                    setFields((fs) => fs.filter((_, n) => n !== i))
                  }
                >
                  ×
                </button>
              </div>
              <small>
                {field.concept_id} · {field.target_type} ·{" "}
                {field.target_unit || "단위 없음"} · 소스 {field.sources.length}
                개
              </small>
              {field.sources.map((s: Row, j: number) => (
                <div className="v2-inline" key={j}>
                  <code>
                    {s.application_id.slice(0, 8)} / {s.rule_key}
                  </code>
                  <button
                    aria-label="소스 삭제"
                    onClick={() =>
                      setFields((fs) =>
                        fs.map((f, n) =>
                          n === i
                            ? {
                                ...f,
                                sources: f.sources.filter(
                                  (_: Row, k: number) => j !== k,
                                ),
                              }
                            : f,
                        ),
                      )
                    }
                  >
                    제거
                  </button>
                </div>
              ))}
              {mode === "aggregate" && (
                <label>
                  집계
                  <select
                    value={field.aggregate}
                    onChange={(e) =>
                      setFields((fs) =>
                        fs.map((f, n) =>
                          n === i ? fieldForMode(f, mode, e.target.value) : f,
                        ),
                      )
                    }
                  >
                    {["sum", "min", "max", "count"].map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          ))}
          <label>
            행 결합 방식
            <select
              value={mode}
              onChange={(e) => {
                const next = e.target.value;
                setFields((fs) => fs.map((f) => fieldForMode(f, next)));
                setMode(next);
              }}
            >
              <option value="record_scope">같은 문서·시트·표의 업무 행</option>
              <option value="business_key">문서 간 명시한 업무키로 결합</option>
              <option value="aggregate">중복을 제거하고 전체 집계</option>
            </select>
          </label>
          {mode === "business_key" && (
            <label className="v2-check">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              소스에 업무키 행/열을 지정했고, 같은 키가 같은 업무 대상을 뜻함을
              확인했습니다.
            </label>
          )}
          <p className="v2-note">
            같은 원본·변환은 중복 제거됩니다. 서로 다른 원본이 한 행·필드에
            충돌하면 빌드가 중단됩니다.
          </p>
          <details
            className="v2-details"
            onToggle={(e) => {
              if (e.currentTarget.open) setJson(JSON.stringify(spec, null, 2));
            }}
          >
            <summary>통합 명세 · 과거 실행 고정</summary>
            <p>소스에 pinned_run_id를 넣어 과거 실행을 고정할 수 있습니다.</p>
            <textarea
              className="v2-code"
              aria-label="통합 명세 JSON"
              rows={16}
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
            <button
              onClick={() => {
                try {
                  const parsed = JSON.parse(json);
                  if (
                    !Array.isArray(parsed.fields) ||
                    parsed.kg_revision_id !== kg
                  )
                    throw new Error("현재 KG의 fields 배열이 필요합니다.");
                  setFields(parsed.fields);
                  setMode(parsed.row_mode);
                  setConfirmed(!!parsed.business_key_confirmed);
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              설정에 반영
            </button>
          </details>
          <button
            className="primary full"
            disabled={busy || tasks.busy || !fields.length}
            onClick={create}
          >
            통합 명세 저장 · DB 생성
          </button>
          <p className="v2-error" role="alert">
            {error}
          </p>
        </section>
      </div>
      <section className="v2-card v2-space">
        <h2>생성한 DB</h2>
        <div className="v2-grid two">
          <div>
            <h3>프로젝트</h3>
            <State resource={projects} />
            {projects.data?.items.map((p) => (
              <button
                className={
                  "v2-list-item " +
                  (route.project === p.integration_version_id ? "selected" : "")
                }
                key={p.project_id}
                onClick={() =>
                  go({
                    project: p.integration_version_id,
                    build: "",
                    output_row: "",
                    field: "",
                    lineage_item: "",
                  })
                }
              >
                <span>
                  <strong>{p.name}</strong>
                  <small>명세 v{p.revision_no}</small>
                </span>
              </button>
            ))}
            <Pager page={projects} />
          </div>
          <div>
            <div className="v2-card-head">
              <h3>실행 이력</h3>
              {route.project && (
                <button
                  disabled={tasks.busy}
                  onClick={() =>
                    tasks.run(
                      "/integrations/" + route.project + "/build",
                      {},
                      (result) => {
                        changed();
                        go({
                          project: result.integration_version_id,
                          build: result.build_id,
                        });
                      },
                    )
                  }
                >
                  현재 소스로 재생성
                </button>
              )}
            </div>
            <State resource={builds} />
            {builds.data?.items.map((b) => (
              <button
                className={
                  "v2-list-item " +
                  (route.build === b.build_id ? "selected" : "")
                }
                key={b.build_id}
                disabled={b.status !== "succeeded"}
                onClick={() =>
                  go({
                    build: b.build_id,
                    output_row: "",
                    field: "",
                    lineage_item: "",
                  })
                }
              >
                <span>
                  <strong>{b.created_at}</strong>
                  <small>
                    {b.status} · {b.row_count ?? "—"}행
                  </small>
                </span>
              </button>
            ))}
            <Pager page={builds} />
          </div>
        </div>
      </section>
      {route.build && (
        <section className="v2-card v2-space">
          <div className="v2-card-head">
            <h2>결과 미리보기</h2>
            <button
              className="primary"
              onClick={() =>
                download(route.build).catch((e) => setError(e.message))
              }
            >
              SQLite 다운로드
            </button>
          </div>
          <p className="v2-muted">
            텍스트는 256자까지 표시합니다. 값의 출처를 열거나 다운로드에서 전체
            값을 확인하세요. Decimal은 정밀도를 유지하는 TEXT이며 타입·단위는
            _field_schema에 있습니다.
          </p>
          <State resource={rows} />
          <div className="v2-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>행</th>
                  {rows.data?.fields?.map((f) => (
                    <th key={f.field_key}>
                      {f.output_name} <small>{f.unit || ""}</small>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.data?.items.map((row) => (
                  <tr key={row._row_no}>
                    <td>{row._row_no}</td>
                    {rows.data?.fields?.map((f) => (
                      <td key={f.field_key}>
                        <button
                          className="v2-link"
                          onClick={() =>
                            go({
                              output_row: row._row_key,
                              field: f.field_key,
                              lineage_item: "",
                            })
                          }
                        >
                          {row[f.output_name] ?? "빈칸"}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={rows} />
          {route.output_row && (
            <div className="v2-grid two">
              <div>
                <h3>기여 항목 · {route.field}</h3>
                <State resource={lineage} />
                {lineage.data?.items.map((l) => (
                  <button
                    className={
                      "v2-list-item " +
                      (route.lineage_item === l.item_id ? "selected" : "")
                    }
                    key={l.ordinal}
                    onClick={() => go({ lineage_item: l.item_id })}
                  >
                    <span>
                      <strong>{l.contribution_role}</strong>
                      <small>{l.item_id}</small>
                    </span>
                    <span>출처 →</span>
                  </button>
                ))}
                <Pager page={lineage} />
              </div>
              <div>
                <h3>기여 영역</h3>
                <State resource={regions} />
                {regions.data?.items.map((p) => (
                  <button
                    className="v2-list-item"
                    key={p.role + ":" + p.ordinal}
                    disabled={!selectedItem.data}
                    onClick={() => focus(p)}
                  >
                    <span>
                      <strong>
                        {p.name}!{range(p.r1, p.c1, p.r2, p.c2)}
                      </strong>
                      <small>
                        {p.role} · 버전 {p.document_version_id.slice(0, 8)}
                      </small>
                    </span>
                    <span>원본 ↗</span>
                  </button>
                ))}
                <Pager page={regions} />
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
}
