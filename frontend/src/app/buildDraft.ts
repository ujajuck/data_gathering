// 문서 → 데이터 빌드 인계(§7 buildDraft): URL에 ID를 싣지 않고 메모리 + sessionStorage('schema.build.draft')로 넘긴다.
import { useSyncExternalStore } from "react";

export type BuildDraft = { document_ids: string[]; schema_key?: string };

export const BUILD_DRAFT_KEY = "schema.build.draft";
const EMPTY: BuildDraft = { document_ids: [] };

let draft: BuildDraft = read();
const listeners = new Set<() => void>();

function read(): BuildDraft {
  try {
    const raw = sessionStorage.getItem(BUILD_DRAFT_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<BuildDraft>;
    return {
      document_ids: Array.isArray(parsed.document_ids)
        ? parsed.document_ids.filter((id): id is string => typeof id === "string")
        : [],
      ...(parsed.schema_key ? { schema_key: parsed.schema_key } : {}),
    };
  } catch {
    return EMPTY;
  }
}

function write(next: BuildDraft) {
  draft = next;
  try {
    if (next.document_ids.length || next.schema_key)
      sessionStorage.setItem(BUILD_DRAFT_KEY, JSON.stringify(next));
    else sessionStorage.removeItem(BUILD_DRAFT_KEY);
  } catch {
    // 저장소를 쓸 수 없어도 메모리 초안은 유지한다.
  }
  listeners.forEach((listener) => listener());
}

export function getBuildDraft(): BuildDraft {
  return draft;
}

export function subscribeBuildDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// 추가된 새 문서 수를 돌려준다(이미 있던 문서는 세지 않는다).
export function addToBuildDraft(documentIds: string[], schemaKey?: string): number {
  const before = draft.document_ids.length;
  const ids = [...new Set([...draft.document_ids, ...documentIds])];
  write({
    document_ids: ids,
    ...(schemaKey ?? draft.schema_key ? { schema_key: schemaKey ?? draft.schema_key } : {}),
  });
  return ids.length - before;
}

export function removeFromBuildDraft(documentId: string) {
  write({
    ...draft,
    document_ids: draft.document_ids.filter((id) => id !== documentId),
  });
}

export function setBuildDraftSchema(schemaKey: string | undefined) {
  const next: BuildDraft = { document_ids: draft.document_ids };
  if (schemaKey) next.schema_key = schemaKey;
  write(next);
}

export function clearBuildDraft() {
  write(EMPTY);
}

// 세션 저장소를 다른 곳(테스트·다른 탭)에서 바꿨을 때 다시 읽는다.
export function reloadBuildDraft() {
  write(read());
}

export function useBuildDraft(): BuildDraft {
  return useSyncExternalStore(subscribeBuildDraft, getBuildDraft, getBuildDraft);
}
