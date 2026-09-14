// §7 표시 규칙: 어떤 화면·오버레이에도 UUID·SHA-256이 텍스트로 보이면 안 된다.
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SHA_RE, UUID_RE, ids, appFixture } from "./fixture";
import { buildFixture } from "./build-fixture";
import { documentsFixture } from "./documents-fixture";
import { jobsFixture } from "./jobs-fixture";
import { profilesFixture } from "./profiles-fixture";
import { schemaFixture } from "./schema-fixture";
import { settleNetwork } from "./source-files";
import { sourceReviewFixture } from "./source-review-fixture";

type Case = { name: string; url: string; fixture: () => { calls: unknown[]; renderApp: (url: string) => unknown }; landmark: () => Promise<unknown> };

const doc1 = ids.document(1);
const cases: Case[] = [
  { name: "문서 목록", url: "?screen=documents", fixture: documentsFixture, landmark: () => screen.findByRole("table", { name: "문서 목록" }) },
  { name: "문서 상세 · 파일 보기", url: `?screen=documents&document=${doc1}`, fixture: documentsFixture, landmark: () => screen.findByRole("dialog", { name: "문서 상세" }) },
  { name: "문서 상세 · 추출 결과", url: `?screen=documents&document=${doc1}&tab=values`, fixture: documentsFixture, landmark: () => screen.findByRole("table", { name: "추출 결과" }) },
  { name: "문서 상세 · 적용 프로파일", url: `?screen=documents&document=${doc1}&tab=profiles`, fixture: documentsFixture, landmark: () => screen.findByRole("table", { name: "적용 프로파일" }) },
  { name: "문서 상세 · 연결 스키마", url: `?screen=documents&document=${doc1}&tab=schemas`, fixture: documentsFixture, landmark: () => screen.findByRole("dialog", { name: "문서 상세" }) },
  { name: "파싱 프로파일 목록", url: "?screen=profiles", fixture: profilesFixture, landmark: () => screen.findByRole("table", { name: "파싱 프로파일 목록" }) },
  { name: "프로파일 상세", url: `?screen=profiles&profile=${ids.profile}`, fixture: profilesFixture, landmark: () => screen.findByLabelText("프로파일 JSON") },
  { name: "프로파일 상세 · 리비전 보기", url: `?screen=profiles&profile=${ids.profile}&rev=1`, fixture: profilesFixture, landmark: () => screen.findByRole("table", { name: "변경 이력" }) },
  { name: "파싱 스키마 · 트리", url: "?screen=schema", fixture: schemaFixture, landmark: () => screen.findByRole("tree", { name: "필드 트리" }) },
  { name: "파싱 스키마 · 필드 상세", url: "?screen=schema&schema=process_std&field_key=temperature", fixture: schemaFixture, landmark: () => screen.findByRole("region", { name: "필드 상세" }) },
  { name: "파싱 스키마 · 그래프", url: "?screen=schema&schema=process_std&view=graph", fixture: schemaFixture, landmark: () => screen.findByRole("img", { name: "스키마 그래프" }) },
  { name: "파싱 스키마 · 사용 프로파일", url: "?screen=schema&schema=process_std&tab=profiles", fixture: schemaFixture, landmark: () => screen.findByRole("table", { name: "사용 프로파일" }) },
  { name: "파싱 스키마 · 연관 문서", url: "?screen=schema&schema=process_std&tab=documents", fixture: schemaFixture, landmark: () => screen.findByRole("table", { name: "연관 문서" }) },
  { name: "파싱 스키마 · 변경 이력", url: "?screen=schema&schema=process_std&tab=history", fixture: schemaFixture, landmark: () => screen.findByRole("table", { name: "변경 이력" }) },
  { name: "데이터 빌드 · 대상 문서", url: "?screen=build", fixture: () => buildFixture(), landmark: () => screen.findByRole("table", { name: "대상 문서" }) },
  { name: "데이터 빌드 · 스키마", url: "?screen=build&step=2", fixture: () => buildFixture(), landmark: () => screen.findByLabelText("파싱 스키마") },
  { name: "데이터 빌드 · 출력 설정", url: "?screen=build&step=3", fixture: () => buildFixture({ schemaKey: "process_std" }), landmark: () => screen.findByRole("table", { name: "출력 컬럼 설정" }) },
  { name: "데이터 빌드 · 미리보기", url: "?screen=build&step=4", fixture: () => buildFixture({ schemaKey: "process_std" }), landmark: () => screen.findByRole("table", { name: "미리보기" }) },
  { name: "데이터 빌드 · 생성", url: "?screen=build&step=5", fixture: () => buildFixture({ schemaKey: "process_std" }), landmark: () => screen.findByRole("radiogroup", { name: "출력 형식" }) },
  { name: "작업 내역", url: "?screen=jobs", fixture: () => jobsFixture({ running: false }), landmark: () => screen.findByRole("table", { name: "작업 목록" }) },
  ...(["unmatched", "review", "failed", "changed", "conflict"] as const).map((q) => ({
    name: `작업 내역 · ${q} 큐`,
    url: `?screen=jobs&queue=${q}`,
    fixture: () => jobsFixture({ running: false }),
    landmark: () => screen.findByRole("group", { name: "검수 큐 요약" }),
  })),
  { name: "설정", url: "?screen=settings", fixture: appFixture, landmark: () => screen.findByRole("table", { name: "정규화 프리셋 목록" }) },
  { name: "Source Review · 검수", url: `?screen=documents&review=${ids.application}`, fixture: sourceReviewFixture, landmark: () => screen.findByRole("dialog", { name: "Source Review" }) },
  {
    name: "Source Review · 규칙·범위 지정",
    url: `?screen=documents&review=${ids.application}&rule=pressure&sheet=${ids.sheet1}&range=D3:D7`,
    fixture: sourceReviewFixture,
    landmark: () => screen.findByTestId("mapping-panel"),
  },
  {
    name: "Source Review · 테스트 모드",
    url: `?screen=documents&test=${ids.profile}&snapshot=${ids.snapshot}`,
    fixture: sourceReviewFixture,
    landmark: () => screen.findByTestId("test-panel"),
  },
];

describe("화면 텍스트에 ID가 보이지 않는다(§7)", () => {
  it.each(cases)("$name", async ({ url, fixture, landmark }) => {
    const f = fixture();
    f.renderApp(url);
    await landmark();
    await settleNetwork(f);
    const text = document.body.textContent || "";
    expect(text).not.toMatch(UUID_RE);
    expect(text).not.toMatch(SHA_RE);
    // 잘린 UUID 조각(예: 앞 8자리)도 라벨로 쓰지 않는다.
    expect(text).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}\b/i);
  });
});
