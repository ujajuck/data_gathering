// §0/§7 재사용 규칙: v3는 v2 모듈 중 DomainGraph의 순수 export(레이아웃·색)와 타입만 가져온다.
import { describe, expect, it } from "vitest";
import { listV3Files, readSource, stripComments } from "./v3-source-files";

const ALLOWED_V2_MODULE = "../v2/DomainGraph";
const ALLOWED_V2_VALUES = new Set(["layoutDomain", "groupColor", "GROUP_COLORS"]);

type Import = { file: string; line: number; text: string; specifier: string };

function importsOf(file: string): Import[] {
  const out: Import[] = [];
  const src = stripComments(readSource(file));
  const re = /(import\s+(?:type\s+)?[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|export\s+[^;]*?from\s*["']([^"']+)["'])/g;
  for (const m of src.matchAll(re)) {
    const specifier = m[2] || m[3] || m[4];
    const line = src.slice(0, m.index).split("\n").length;
    out.push({ file: file.replace(/^.*\/src\/v3\//, "src/v3/"), line, text: m[0], specifier });
  }
  return out;
}

describe("v3 import 규칙", () => {
  const files = listV3Files().filter((f) => /\.tsx?$/.test(f));
  const all = files.flatMap(importsOf);

  it("../v2/client · ../v2/Workbench · 기타 v2 모듈을 가져오지 않는다", () => {
    const v2 = all.filter((i) => /(^|\/)v2\//.test(i.specifier));
    const bad = v2.filter((i) => i.specifier !== ALLOWED_V2_MODULE);
    expect(bad.map((i) => `${i.file}:${i.line} ${i.specifier}`)).toEqual([]);
    expect(all.some((i) => /v2\/(client|Workbench)/.test(i.specifier))).toBe(false);
  });

  it("../v2/DomainGraph에서는 layoutDomain·groupColor·GROUP_COLORS와 타입만 가져온다", () => {
    const graph = all.filter((i) => i.specifier === ALLOWED_V2_MODULE);
    expect(graph.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const i of graph) {
      if (/^import\s+type\s/.test(i.text)) continue;
      if (/^export\s/.test(i.text) || /^import\s*\(/.test(i.text)) {
        bad.push(`${i.file}:${i.line} ${i.text}`);
        continue;
      }
      const names = i.text.match(/\{([^}]*)\}/)?.[1] ?? "";
      if (!i.text.includes("{") || /^import\s+\w/.test(i.text.replace(/^import\s+type\s+/, ""))) bad.push(`${i.file}:${i.line} default/namespace import: ${i.text}`);
      for (const raw of names.split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
        if (!name) continue;
        if (raw.trim().startsWith("type ")) continue;
        if (!ALLOWED_V2_VALUES.has(name)) bad.push(`${i.file}:${i.line} ${name}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("v3 화면은 ../product 외의 상위 모듈을 가져오지 않는다", () => {
    const outside = all.filter((i) => i.specifier.startsWith("../") && !/^\.\.\/(v2\/DomainGraph|product)$/.test(i.specifier));
    expect(outside.map((i) => `${i.file}:${i.line} ${i.specifier}`)).toEqual([]);
  });
});
