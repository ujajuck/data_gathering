// §0/§7 재사용 규칙: 앱 화면은 자기 폴더(src/app) 안과 `../product`만 가져온다. 지워진 옛 화면 모듈은 남아 있으면 안 된다.
import { describe, expect, it } from "vitest";
import { listAppFiles, readSource, stripComments } from "./source-files";

type Import = { file: string; line: number; text: string; specifier: string };

function importsOf(file: string): Import[] {
  const out: Import[] = [];
  const src = stripComments(readSource(file));
  const re = /(import\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|export\s+[^;]*?from\s*["']([^"']+)["'])/g;
  for (const m of src.matchAll(re)) {
    const specifier = m[2] || m[3] || m[4];
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file: file.replace(/^.*\/src\/app\//, "src/app/"), line, text: m[0], specifier });
  }
  return out;
}

describe("앱 import 규칙", () => {
  const files = listAppFiles().filter((f) => /\.tsx?$/.test(f));
  const all = files.flatMap(importsOf);

  it("정적 검사가 실제로 import를 읽는다", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(all.length).toBeGreaterThan(20);
  });

  it("지워진 옛 화면 모듈(v1 screens·lib·viewer, v2)을 가져오지 않는다", () => {
    const legacy = all.filter((i) => /(^|\/)(v1|v2|screens|lib|viewer|parsing)\//.test(i.specifier));
    expect(legacy.map((i) => `${i.file}:${i.line} ${i.specifier}`)).toEqual([]);
  });

  it("화면은 ../product 외의 상위 모듈을 가져오지 않는다", () => {
    const outside = all.filter((i) => i.specifier.startsWith("../") && i.specifier !== "../product");
    expect(outside.map((i) => `${i.file}:${i.line} ${i.specifier}`)).toEqual([]);
  });
});
