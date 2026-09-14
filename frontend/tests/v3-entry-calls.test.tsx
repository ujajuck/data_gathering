// §7 성능 규칙: 화면 진입(첫 렌더) 시 화면 고유 API 호출은 3개 이하다.
// 쉘 호출(GET /status, JobBar의 GET /jobs?state=running)과 시트 렌더 타일(…/render)은 제외한다.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Call } from "./v3-fixture";
import { ids, v3Fixture } from "./v3-fixture";
import { buildFixture } from "./v3-build-fixture";
import { documentsFixture } from "./v3-documents-fixture";
import { jobsFixture } from "./v3-jobs-fixture";
import { profilesFixture } from "./v3-profiles-fixture";
import { schemaFixture } from "./v3-schema-fixture";
import { settleNetwork } from "./v3-source-files";
import { sourceReviewFixture } from "./v3-source-review-fixture";

const isShell = (c: Call) => c.path === "/status" || (c.path === "/jobs" && c.url.searchParams.get("state") === "running");
const isRenderTile = (c: Call) => /\/render$/.test(c.path);

type Case = {
  name: string;
  url: string;
  fixture: () => { calls: Call[]; renderApp: (url: string) => unknown };
  landmark: () => Promise<unknown>;
  expected: string[];
};

const cases: Case[] = [
  { name: "문서", url: "?screen=documents", fixture: documentsFixture, landmark: () => screen.findByRole("table", { name: "문서 목록" }), expected: ["GET /documents", "GET /profiles"] },
  { name: "파싱 프로파일 목록", url: "?screen=profiles", fixture: profilesFixture, landmark: () => screen.findByRole("table", { name: "파싱 프로파일 목록" }), expected: ["GET /profiles"] },
  {
    name: "파싱 프로파일 상세",
    url: `?screen=profiles&profile=${ids.profile}`,
    fixture: profilesFixture,
    landmark: () => screen.findByRole("table", { name: "적용 문서" }),
    expected: ["GET /profiles", `GET /profiles/${ids.profile}`, `GET /profiles/${ids.profile}/documents`],
  },
  { name: "파싱 스키마", url: "?screen=schema", fixture: schemaFixture, landmark: () => screen.findByRole("tree", { name: "필드 트리" }), expected: ["GET /schemas", "GET /schemas/process_std", "GET /schemas/process_std/tree"] },
  { name: "데이터 빌드", url: "?screen=build", fixture: () => buildFixture(), landmark: () => screen.findByRole("table", { name: "대상 문서" }), expected: ["POST /builds/candidates"] },
  { name: "작업 내역", url: "?screen=jobs", fixture: () => jobsFixture({ running: false }), landmark: () => screen.findByRole("table", { name: "작업 목록" }), expected: ["GET /queues", "GET /jobs", "GET /queues/unmatched"] },
  { name: "설정", url: "?screen=settings", fixture: v3Fixture, landmark: () => screen.findByRole("table", { name: "정규화 프리셋 목록" }), expected: ["GET /settings", "GET /normalization-presets"] },
  {
    name: "Source Review(검수)",
    url: `?screen=documents&review=${ids.application}`,
    fixture: sourceReviewFixture,
    landmark: () => screen.findByTestId("mapping-panel"),
    // 문서 화면 뒤에 열리므로 문서 목록 호출 2개 + 집계 1개.
    expected: ["GET /documents", "GET /profiles", `GET /applications/${ids.application}`],
  },
];

describe("화면 진입 API 호출 수(§7 ≤ 3)", () => {
  it.each(cases)("$name", async ({ url, fixture, landmark, expected }) => {
    const f = fixture();
    f.renderApp(url);
    await landmark();
    await settleNetwork(f);
    const own = f.calls.filter((c) => !isShell(c) && !isRenderTile(c));
    const labels = own.map((c) => `${c.method} ${c.path}`);
    expect(labels.sort()).toEqual([...expected].sort());
    expect(own.length).toBeLessThanOrEqual(3);
    // 같은 GET을 두 번 부르지 않는다(in-flight 중복 제거·캐시).
    const gets = own.filter((c) => c.method === "GET").map((c) => c.path + c.url.search);
    expect(new Set(gets).size).toBe(gets.length);
    // 쉘의 /status는 한 번만.
    expect(f.calls.filter((c) => c.path === "/status")).toHaveLength(1);
    // 목록은 keyset 페이징 50건 이하.
    for (const c of own) {
      const limit = c.url.searchParams.get("limit");
      if (limit) expect(Number(limit)).toBeLessThanOrEqual(50);
    }
  });

  it("Source Review 테스트 모드 진입은 POST test + 시트 + 프로파일 라벨 3개다", async () => {
    const f = sourceReviewFixture();
    f.renderApp(`?screen=documents&test=${ids.profile}&snapshot=${ids.snapshot}`);
    await screen.findByTestId("test-panel");
    await settleNetwork(f);
    const own = f.calls.filter((c) => !isShell(c) && !isRenderTile(c) && !/^\/(documents|profiles)$/.test(c.path));
    expect(own.map((c) => `${c.method} ${c.path}`).sort()).toEqual(
      [`POST /profiles/${ids.profile}/test`, `GET /snapshots/${ids.snapshot}/sheets`, `GET /profiles/${ids.profile}`].sort(),
    );
  });
});
