// 접근성 정적 검사: 표 머리글 scope, 표 이름, 모달 속성, 아이콘 전용 버튼 이름, 내비게이션 aria-current.
import { describe, expect, it } from "vitest";
import { listAppFiles, readSource, stripComments } from "./source-files";

const files = listAppFiles().filter((f) => f.endsWith(".tsx"));
const short = (f: string) => f.replace(/^.*\/src\/app\//, "src/app/");

function tags(source: string, tag: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  const re = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, "g");
  for (const m of source.matchAll(re)) out.push({ line: source.slice(0, m.index).split("\n").length, text: m[0] });
  return out;
}

describe("접근성 규칙(정적)", () => {
  it("모든 <th>에 scope가 있다", () => {
    const bad = files.flatMap((f) => tags(stripComments(readSource(f)), "th").filter((t) => !/\bscope=/.test(t.text)).map((t) => `${short(f)}:${t.line} ${t.text}`));
    expect(bad).toEqual([]);
  });

  it("모든 <table>에 aria-label이 있다", () => {
    const bad = files.flatMap((f) => tags(stripComments(readSource(f)), "table").filter((t) => !/\baria-label/.test(t.text)).map((t) => `${short(f)}:${t.line} ${t.text}`));
    expect(bad).toEqual([]);
  });

  it('role="dialog"에는 aria-modal과 aria-label이 함께 있다', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = stripComments(readSource(f));
      for (const m of src.matchAll(/<[a-z]+[^>]*role="dialog"[^>]*>/gs)) {
        if (!/aria-modal/.test(m[0]) || !/aria-label/.test(m[0])) bad.push(`${short(f)}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("<nav>에는 aria-label이 있고 항목은 aria-current를 쓴다", () => {
    const navs = files.flatMap((f) => tags(stripComments(readSource(f)), "nav").map((t) => `${short(f)}:${t.line} ${t.text}`));
    expect(navs.length).toBeGreaterThan(0);
    expect(navs.filter((n) => !/aria-label/.test(n))).toEqual([]);
    const shell = stripComments(readSource(files.find((f) => f.endsWith("Workbench.tsx"))!));
    expect(shell).toMatch(/aria-current=\{[^}]*"page"/);
  });

  it("텍스트가 없는 버튼(×·+·− 등)은 aria-label을 갖는다", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = stripComments(readSource(f));
      for (const m of src.matchAll(/<button\b([^>]*)>\s*([^<{]*?)\s*<\/button>/gs)) {
        const attrs = m[1];
        const text = m[2].trim();
        if (text && !/^[×+−\-–·…]$/.test(text)) continue;
        if (!/aria-label/.test(attrs)) bad.push(`${short(f)}: <button${attrs.slice(0, 60)}>${text}</button>`);
      }
    }
    expect(bad).toEqual([]);
  });
});
