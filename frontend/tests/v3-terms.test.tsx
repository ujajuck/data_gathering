// §0 용어 규칙: v3 소스(주석 제외)에 옛 용어가 남아 있으면 안 된다.
import { describe, expect, it } from "vitest";
import { listV3Files, readSource, stripComments } from "./v3-source-files";

const BANNED = /템플릿|문서군|\bKG\b|Concept|Integration|Template/;

describe("v3 용어 규칙(§0)", () => {
  it("src/v3 아래 모든 파일의 코드·문자열에 금지 용어가 없다", () => {
    const files = listV3Files();
    expect(files.length).toBeGreaterThan(20);
    const hits: string[] = [];
    for (const file of files) {
      const lines = stripComments(readSource(file)).split("\n");
      lines.forEach((line, i) => {
        const m = line.match(BANNED);
        if (m) hits.push(`${file.replace(/^.*\/src\/v3\//, "src/v3/")}:${i + 1}: ${m[0]} — ${line.trim().slice(0, 100)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("주석 제거 도우미는 블록·행 주석만 지우고 URL은 남긴다", () => {
    const src = 'const a = "http://x/y"; // Template\n/* Concept */ const b = 1;\n{/* KG */}\n';
    const out = stripComments(src);
    expect(out).toContain('"http://x/y"');
    expect(out).not.toMatch(/Template|Concept|KG/);
  });
});
