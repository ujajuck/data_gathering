// 문서 화면 테스트 픽스처: 공용 v3Fixture 위에 원본 폴더 트리(GET /sources?directory=)와 파일별 등록 결과
// (POST /documents/register?wait=10), 폴더 일괄 등록(§4.1.1 GET /sources/scan · POST /documents/register-directory)을
// 덧붙인다.
import type { RegisterResult, SourceEntry, SourceScan } from "../src/v3/types";
import { job, page, uuid, v3Fixture } from "./v3-fixture";

type Row = Record<string, any>;

export const SOURCE_TREE: Record<string, SourceEntry[]> = {
  "": [
    { name: "2024", source_ref: "2024", directory: true },
    { name: "샘플.xlsx", source_ref: "샘플.xlsx", directory: false, size: 20480, modified_at: "2026-09-01T00:00:00Z" },
  ],
  "2024": [
    { name: "공정데이터_2024_05.xlsx", source_ref: "2024/공정데이터_2024_05.xlsx", directory: false, size: 40960, modified_at: "2026-09-10T00:00:00Z" },
    { name: "공정데이터_2024_06.xlsx", source_ref: "2024/공정데이터_2024_06.xlsx", directory: false, size: 40960, modified_at: "2026-09-11T00:00:00Z" },
    { name: "손상파일.xlsx", source_ref: "2024/손상파일.xlsx", directory: false, size: 12, modified_at: "2026-09-12T00:00:00Z" },
  ],
};

// §4.1.1 스캔 미리보기. 최상위는 등록 대상이 없고(targeted 0), 2024는 새 파일 2 · 변경 1 · 변경 없음 1 · 잠김 1이다.
export const SOURCE_SCAN: Record<string, SourceScan> = {
  "": {
    directory: "",
    folders: 1,
    files: 6,
    states: { new: 0, changed: 0, unchanged: 5, locked: 1 },
    skipped: { temp: 0, unsupported: 1, symlink: 0 },
    targeted: 0,
    limit: 10000,
    sample: [{ source_ref: "샘플.xlsx", state: "unchanged" }],
  },
  "2024": {
    directory: "2024",
    folders: 1,
    files: 5,
    states: { new: 2, changed: 1, unchanged: 1, locked: 1 },
    skipped: { temp: 1, unsupported: 2, symlink: 0 },
    targeted: 3,
    limit: 10000,
    sample: [
      { source_ref: "2024/공정데이터_2024_05.xlsx", state: "new" },
      { source_ref: "2024/공정데이터_2024_06.xlsx", state: "new" },
      { source_ref: "2024/손상파일.xlsx", state: "changed" },
    ],
  },
};

// 기본(include_unchanged=false) 등록 대상과, 다시 읽기를 켰을 때 더해지는 파일.
export const DIRECTORY_REFS = ["2024/공정데이터_2024_05.xlsx", "2024/공정데이터_2024_06.xlsx", "2024/손상파일.xlsx"];
export const DIRECTORY_UNCHANGED_REFS = ["2024/하위/공정데이터_2023_12.xlsx", "2024/하위/보안문서.xlsx"];

export function registerResult(refs: string[]): RegisterResult {
  return {
    documents: refs.map((ref, i) => {
      const name = ref.split("/").pop() || ref;
      const broken = name.startsWith("손상");
      return {
        document_id: uuid(50 + i, "0d0c"),
        document_name: name,
        snapshot: broken ? null : { snapshot_id: uuid(50 + i, "aaaa"), revision_no: 1, captured_at: "2026-09-14T08:30:00Z" },
        status: broken ? "failed" : "normal",
        applied: broken ? [] : [{ profile_name: "공정데이터_A양식", compatibility: "identical", state: "approved" }],
        error: broken ? { code: "READ_FAILED", message: "파일을 열 수 없습니다(손상된 워크북)." } : null,
      };
    }),
  };
}

// §4.1.1 결과: summary(전체 기준) + documents(≤500, source_ref·state 포함) + truncated.
export function registerDirectoryResult(directory: string, includeUnchanged = false): RegisterResult {
  const scan = SOURCE_SCAN[directory] || SOURCE_SCAN[""];
  const refs = includeUnchanged ? [...DIRECTORY_REFS, ...DIRECTORY_UNCHANGED_REFS] : DIRECTORY_REFS;
  const stateOf = (ref: string) =>
    DIRECTORY_UNCHANGED_REFS.includes(ref) ? "unchanged" : ref.includes("손상") ? "changed" : "new";
  const documents = registerResult(refs).documents.map((d, i) => ({ ...d, source_ref: refs[i], state: stateOf(refs[i]) }));
  const failed = documents.filter((d) => d.error).length;
  return {
    directory,
    summary: {
      found: scan.files,
      targeted: refs.length,
      registered: documents.length - failed,
      new: scan.states.new,
      changed: scan.states.changed,
      unchanged: scan.states.unchanged,
      failed,
      locked: scan.states.locked,
      skipped: scan.skipped,
    },
    documents,
    truncated: false,
  };
}

export function documentsFixture() {
  const f = v3Fixture();
  const registered: Row[] = [];
  const scanned: Row[] = [];
  const registeredDirectory: Row[] = [];
  f.overrides.set("GET /sources", (call) => page(SOURCE_TREE[call.url.searchParams.get("directory") || ""] || []));
  f.overrides.set("POST /documents/register", (call) => {
    registered.push({ body: call.body, wait: call.url.searchParams.get("wait") });
    const refs: string[] = call.body?.source_refs || [];
    return job({ kind: "register", label: `문서 등록 ${refs.length}개`, result: registerResult(refs) as unknown as Row });
  });
  f.overrides.set("GET /sources/scan", (call) => {
    const directory = call.url.searchParams.get("directory") || "";
    scanned.push({ directory });
    return SOURCE_SCAN[directory] || { ...SOURCE_SCAN[""], directory };
  });
  f.overrides.set("POST /documents/register-directory", (call) => {
    registeredDirectory.push({ body: call.body, wait: call.url.searchParams.get("wait") });
    const directory: string = call.body?.directory ?? "";
    const result = registerDirectoryResult(directory, !!call.body?.include_unchanged);
    return job({
      kind: "register",
      target_kind: "workspace",
      target_id: null,
      label: `${directory ? directory.split("/").pop() : "원본 폴더"} 폴더 일괄 등록`,
      completed: result.documents.length,
      total: result.documents.length,
      result: result as unknown as Row,
    });
  });
  return { ...f, registered, scanned, registeredDirectory };
}
