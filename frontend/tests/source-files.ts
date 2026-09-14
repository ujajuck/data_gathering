// 앱 소스 파일을 읽는 정적 검사용 도우미(용어·import 규칙 테스트 공용).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// jsdom 환경에서는 import.meta.url이 http URL이므로 작업 디렉터리 기준으로 찾는다(frontend/ 또는 저장소 루트).
export const APP_ROOT = [resolve(process.cwd(), "src/app"), resolve(process.cwd(), "frontend/src/app")].find((d) => existsSync(join(d, "client.ts")))!;

export function listAppFiles(dir = APP_ROOT): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listAppFiles(full));
    else out.push(full);
  }
  return out;
}

export const readSource = (path: string) => readFileSync(path, "utf8");

// 주석을 지운다: /* … */ 블록(JSX {/* */} 포함)과 행 끝 // 주석(URL의 `://`는 남긴다).
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (_m, lead: string) => lead);
}

// 네트워크(fetch 목)가 quietMs 동안 조용해질 때까지 기다린다(화면 진입 호출 수 세기용).
export async function settleNetwork(f: { calls: unknown[] }, quietMs = 300, maxMs = 10000) {
  const { act } = await import("@testing-library/react");
  const start = Date.now();
  let seen = f.calls.length;
  let changed = Date.now();
  while (Date.now() - changed < quietMs) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 40));
    });
    if (f.calls.length !== seen) {
      seen = f.calls.length;
      changed = Date.now();
    }
    if (Date.now() - start > maxMs) throw new Error(`network did not settle (${f.calls.length} calls)`);
  }
}
