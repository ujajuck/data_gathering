// 문서 화면 테스트 픽스처: 공용 v3Fixture 위에 원본 폴더 트리(GET /sources?directory=)와 파일별 등록 결과
// (POST /documents/register?wait=10)를 덧붙인다.
import type { RegisterResult, SourceEntry } from "../src/v3/types";
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

export function documentsFixture() {
  const f = v3Fixture();
  const registered: Row[] = [];
  f.overrides.set("GET /sources", (call) => page(SOURCE_TREE[call.url.searchParams.get("directory") || ""] || []));
  f.overrides.set("POST /documents/register", (call) => {
    registered.push({ body: call.body, wait: call.url.searchParams.get("wait") });
    const refs: string[] = call.body?.source_refs || [];
    return job({ kind: "register", label: `문서 등록 ${refs.length}개`, result: registerResult(refs) as unknown as Row });
  });
  return { ...f, registered };
}
