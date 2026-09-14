// 파싱 프로파일 편집기 초안 저장소(§7 Profiles → Source Review 테스트 인계).
// 저장하지 않은 정의는 URL에 싣지 않고(`?test=draft&snapshot=<sid>`) 이 모듈 수준 저장소에서 읽는다.
// 메모리 + sessionStorage('schema.profile.draft') — 새로 고침해도 같은 탭 안에서는 남는다.
import { useSyncExternalStore } from "react";

export type ProfileDraft = {
  schema_key: string;
  // canonical 또는 외부 형식의 정의(JSON 편집기 내용). 문자열이면 서버가 형식을 판별한다.
  definition: Record<string, unknown> | string;
  profile_name?: string;
  format?: string;
};

export const PROFILE_DRAFT_KEY = "schema.profile.draft";

const listeners = new Set<() => void>();
let current: ProfileDraft | null = load();

function load(): ProfileDraft | null {
  try {
    const raw = sessionStorage.getItem(PROFILE_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProfileDraft;
    return parsed && typeof parsed === "object" && typeof parsed.schema_key === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function persist(draft: ProfileDraft | null) {
  try {
    if (draft) sessionStorage.setItem(PROFILE_DRAFT_KEY, JSON.stringify(draft));
    else sessionStorage.removeItem(PROFILE_DRAFT_KEY);
  } catch {
    // 저장소를 쓸 수 없으면 메모리에서만 유지된다.
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

function getProfileDraft(): ProfileDraft | null {
  return current;
}

function subscribeProfileDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setProfileDraft(draft: ProfileDraft | null) {
  current = draft;
  persist(draft);
  emit();
}

export function useProfileDraft(): ProfileDraft | null {
  return useSyncExternalStore(subscribeProfileDraft, getProfileDraft, getProfileDraft);
}
