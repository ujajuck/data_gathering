import { vi } from "vitest";
import { range } from "../src/v2/client";

type Row = Record<string, any>;
export const page = (items: Row[], next: string | null = null) => ({
  items,
  next_cursor: next,
  has_more: next !== null,
});
let sequence = 0;

export function workbenchFixture() {
  const tag = String(++sequence);
  const ids = Object.fromEntries(
    [
      "document",
      "version",
      "sheet",
      "common",
      "application",
      "mapping",
      "kg",
      "concept",
      "other",
      "run",
      "series",
      "project",
      "build",
    ].map((key) => [key, `${key}-${tag}`]),
  );
  // 두 번째 문서는 목록 표에서만 쓰는 검수 대기 행이다(open() URL 파라미터는 바꾸지 않는다).
  const second = `${ids.document}-b`;
  const secondVersion = `${ids.version}-b`;
  const reviewApp = `app-${tag}-review`;
  const spec = {
    selector: {
      key: {
        areas: [
          { sheet_role: "main", range: "B3:C3" },
          { sheet_role: "main", range: "D3" },
        ],
      },
      value: {
        areas: [{ sheet_role: "main", range: "B4:C5" }],
        cardinality: "list",
        axis: "down",
        element_layout: "one_per_row",
        stop: { kind: "explicit_areas", max_items: 100 },
      },
      unit: { areas: [{ sheet_role: "common", range: "B1" }] },
    },
    value_spec: { type: "decimal", unit: "°C" },
    record_spec: { scope: ["process-table"], key: { column: "A" } },
  };
  const state: Row = {
    published: true,
    integration: null,
    saved: null,
    mapping: {
      mapping_revision_id: ids.mapping,
      application_id: ids.application,
      kg_revision_id: ids.kg,
      concept_id: ids.concept,
      rule_key: "process_temperature",
      revision_no: 1,
      edit_seq: 3,
      status: "proposed",
      effective_spec: spec,
    },
  };
  const sheets = [
    {
      sheet_id: ids.sheet,
      name: "공정 기록",
      visibility: "visible",
      estimated_rows: 68,
    },
    {
      sheet_id: ids.common,
      name: "공통 정보",
      visibility: "visible",
      estimated_rows: 2,
    },
  ];
  const source = () => ({
    series_id: ids.series,
    run_id: ids.run,
    mapping_revision_id: state.mapping.mapping_revision_id,
    application_id: ids.application,
    concept_id: ids.concept,
    rule_key: "process_temperature",
    observed_key: "공정온도",
    cardinality: "list",
    axis: "down",
    concept_name: "공정온도",
    target_type: "decimal",
    target_unit: "°C",
  });
  function item(index: number) {
    return {
      item_id: `item-${tag}-${index}`,
      record_key: `LOT-${index}`,
      value_text: String(100000 + index),
      unit_normalized: "°C",
      document_id: ids.document,
      document_version_id: ids.version,
      application_id: ids.application,
      mapping_revision_id: state.mapping.mapping_revision_id,
      series_id: ids.series,
    };
  }
  function regions(index: number) {
    return page([
      {
        role: "value",
        ordinal: 0,
        document_version_id: ids.version,
        sheet_id: ids.sheet,
        name: "공정 기록",
        r1: index + 3,
        c1: 2,
        r2: index + 3,
        c2: 3,
      },
      {
        role: "unit",
        ordinal: 1,
        document_version_id: ids.version,
        sheet_id: ids.common,
        name: "공통 정보",
        r1: 1,
        c1: 2,
        r2: 1,
        c2: 2,
      },
    ]);
  }
  function viewport(request: Row) {
    const rows = Array.from({ length: request.rows }, (_, n) => ({
      index: request.r1 + n,
      y: n * 24,
      height: 24,
    }));
    const columns = Array.from({ length: request.cols }, (_, n) => ({
      index: request.c1 + n,
      x: n * 80,
      width: 80,
    }));
    const cells: Row[] = [];
    for (const r of rows)
      for (const c of columns) {
        const merged =
          request.sheet_id === ids.sheet && r.index >= 3 && r.index <= 68;
        if (merged && c.index === 3 && request.c1 < 3) continue;
        const c2 = merged && c.index === 2 ? 3 : c.index;
        const text =
          request.sheet_id === ids.common
            ? c.index === 2 && r.index <= 2
              ? "°C"
              : ""
            : r.index === 3
              ? ({ 2: "공정", 4: "온도", 5: "운전" } as Row)[c.index] || ""
              : c.index === 2 && r.index > 3 && r.index <= 68
                ? String(150 + r.index)
                : "";
        cells.push({
          r1: r.index,
          r2: r.index,
          c1: c.index,
          c2,
          range: range(r.index, c.index, r.index, c2),
          x: c.x,
          y: r.y,
          width: (c2 - c.index + 1) * 80,
          height: 24,
          text,
          style: {},
        });
      }
    return {
      mode: "simplified",
      fidelity: "일반 XLSX 간이 표시",
      rows,
      columns,
      cells,
      images: [],
      width: request.cols * 80,
      height: request.rows * 24,
      access_expires_at: new Date(Date.now() + 60000).toISOString(),
    };
  }
  const calls: {
    path: string;
    method: string;
    body: Row | undefined;
    url: URL;
    signal?: AbortSignal | null;
  }[] = [];
  const overrides = new Map<string, (call: (typeof calls)[number]) => any>();
  function answer(call: (typeof calls)[number]): any {
    const { path, method, body, url } = call;
    const override = overrides.get(method + " " + path);
    if (override) return override(call);
    if (path === "/status") return { schema_version: 2 };
    if (path === "/normalization-presets")
      return page([
        {
          id: "identity",
          label: "원값 유지",
          normalization: { operation: "identity", version: "1" },
        },
        {
          id: "automatic",
          label: "자동 정규화",
          normalization: {
            operation: "pipeline",
            version: "1",
            preset_id: "automatic",
            steps: [{ op: "automatic" }],
          },
        },
      ]);
    if (path === "/review-queue") return page([]);
    if (path.endsWith("/tree"))
      return page([
        {
          concept_id: ids.concept,
          name: "공정온도",
          child_count: 0,
          checked: url.searchParams.getAll("roots").includes(ids.concept),
        },
      ]);
    if (path === "/documents")
      return page([
        {
          document_id: ids.document,
          current_version_id: ids.version,
          display_name: "가상 공정.xlsx",
          provider: "local-xlsx",
          file_type: "xlsx",
          registered_at: "2026-09-09T09:00:00+00:00",
          author: "홍길동",
          authored_at: "2026-09-08T10:00:00",
          access_status: "allowed",
          extraction_status: "published",
          templates: [
            {
              application_id: ids.application,
              template_id: `template-${tag}`,
              template_version_id: `template-version-${tag}`,
              name: "공정 운전 기록",
              revision_no: 1,
              state: "published",
              review_pending: 0,
              scope_key: ids.application,
            },
          ],
          template_count: 1,
          review_pending: 0,
          roots: [
            { concept_id: "plant", name: "공정" },
            { concept_id: "quality", name: "품질" },
          ],
          root_count: 2,
          sort_value: "가상 공정.xlsx",
        },
        {
          document_id: second,
          current_version_id: secondVersion,
          display_name: "가상 검수.xlsx",
          provider: "protected-reader",
          file_type: "xlsx",
          registered_at: "2026-09-09T09:05:00+00:00",
          author: null,
          authored_at: null,
          access_status: "unknown",
          extraction_status: "review",
          templates: [
            {
              application_id: reviewApp,
              template_id: `template-${tag}`,
              template_version_id: `template-version-${tag}`,
              name: "공정 운전 기록",
              revision_no: 1,
              state: "review",
              review_pending: 1,
              scope_key: reviewApp,
            },
          ],
          template_count: 1,
          review_pending: 1,
          roots: [],
          root_count: 0,
          sort_value: "가상 검수.xlsx",
        },
      ]);
    if (path === "/sources" || path === "/templates") return page([]);
    if (path === `/documents/${ids.document}/versions`)
      return page([
        {
          document_version_id: ids.version,
          revision_no: 1,
          filename: "가상 공정.xlsx",
        },
      ]);
    if (path === `/versions/${ids.version}/sheets`) return page(sheets);
    const application = {
      application_id: ids.application,
      name: "공정 운전 기록",
      revision_no: 1,
      published_run_id: state.published ? ids.run : null,
      bindings: sheets.map((s, i) => ({
        ...s,
        role_key: i ? "common" : "main",
      })),
    };
    if (path === "/applications") return page([application]);
    if (path === `/applications/${ids.application}`) return application;
    if (path === `/applications/${ids.application}/mappings`)
      return page([state.mapping]);
    if (path.startsWith("/mappings/")) return state.mapping;
    if (path.endsWith("/revisions") && method === "POST") {
      state.saved = body;
      state.published = false;
      state.mapping = {
        ...state.mapping,
        ...body,
        mapping_revision_id: `${ids.mapping}-saved`,
        revision_no: 2,
        edit_seq: 4,
      };
      return state.mapping;
    }
    if (path === "/kg/revisions")
      return page([{ kg_revision_id: ids.kg, revision_no: 1 }]);
    if (path === `/kg/${ids.kg}/concepts`)
      return page([
        { concept_id: ids.concept, name: "공정온도", level: 2 },
        { concept_id: ids.other, name: "운전온도", level: 2 },
      ]);
    if (path === "/series") return page(state.published ? [source()] : []);
    if (path === `/series/${ids.series}/items`) {
      const start = url.searchParams.has("cursor") ? 31 : 1;
      const limit = Number(url.searchParams.get("limit") || 30);
      return page(
        Array.from({ length: Math.min(limit, 36 - start) }, (_, n) =>
          item(start + n),
        ),
        start === 1 && limit > 1 ? "items-page-2" : null,
      );
    }
    if (path.startsWith(`/items/item-${tag}-`)) {
      const index = Number(path.split("/")[2].split("-").at(-1));
      return path.endsWith("/regions") ? regions(index) : item(index);
    }
    if (path === "/viewports")
      return {
        job_id: `view-${calls.length}`,
        state: "succeeded",
        result: viewport(body!),
      };
    if (path.endsWith("/cancel")) return { state: "cancelled" };
    if (path === "/integrations") {
      if (method === "POST") {
        state.integration = body;
        return { integration_version_id: ids.project };
      }
      return page(
        state.integration
          ? [
              {
                project_id: ids.project,
                integration_version_id: ids.project,
                name: state.integration.name,
                revision_no: 1,
              },
            ]
          : [],
      );
    }
    if (path === `/integrations/${ids.project}/build`)
      return {
        job_id: `build-job-${tag}`,
        kind: "build",
        state: "succeeded",
        result: { integration_version_id: ids.project, build_id: ids.build },
      };
    if (path === "/builds")
      return page([
        {
          build_id: ids.build,
          status: "succeeded",
          row_count: 35,
          created_at: "2026-09-09",
        },
      ]);
    if (path === `/builds/${ids.build}/rows`) {
      const fields = state.integration.spec.fields.map((f: Row) => ({
        ...f,
        unit: f.target_unit,
      }));
      const start = url.searchParams.has("cursor") ? 31 : 1;
      return {
        ...page(
          Array.from({ length: start === 1 ? 30 : 5 }, (_, n) => ({
            _row_no: start + n,
            _row_key: `row-${start + n}`,
            [fields[0].output_name]: String(100000 + start + n),
          })),
          start === 1 ? "output-page-2" : null,
        ),
        fields,
      };
    }
    if (path === `/builds/${ids.build}/lineage`)
      return page([
        { ordinal: 0, item_id: item(31).item_id, contribution_role: "value" },
      ]);
    if (path.endsWith("/suggestions"))
      return {
        ...page([]),
        threshold: 0.5,
        signature_status: "ready",
        candidates: 0,
        unsigned_candidates: 0,
      };
    throw new Error(`No fixture for ${method} ${path}`);
  }
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://component.test");
    const call = {
      path: url.pathname.replace(/^\/api\/v2/, ""),
      method: init.method || "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      url,
      signal: init.signal,
    };
    calls.push(call);
    const data = await answer(call);
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    ids,
    state,
    calls,
    overrides,
    viewport,
    item,
    open(tab: string, extra: Row = {}) {
      const params = new URLSearchParams({ v2: "1", tab, ...ids, ...extra });
      // IDs used only as fixture helpers must not select unrelated result views.
      for (const key of ["common", "other", "run", "project", "build"])
        params.delete(key);
      history.replaceState({}, "", "?" + params);
    },
  };
}
