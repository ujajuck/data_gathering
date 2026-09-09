import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Workbench from "../src/v2/Workbench";
import { page, workbenchFixture } from "./workbench-fixture";

type Row = Record<string, any>;

function suggestion(f: ReturnType<typeof workbenchFixture>, score: number, extra: Row = {}) {
  return {
    score,
    // 서버는 헤더·병합 성분을 개수로만 설명한다(다른 문서의 셀 문자열은 오지 않는다).
    breakdown: {
      sheet_names: { score: 1, shared: ["공정 기록", "공통 정보"] },
      headers: { score: 0.9, shared_count: 5, target_count: 5, source_count: 6 },
      merges: { score: 0.8, shared_count: 3, target_count: 3, source_count: 4 },
    },
    source_application_id: "app-src",
    source_document_id: "doc-src",
    source_document_name: "이전 보고서.xlsx",
    source_version_id: "version-src",
    source_revision_no: 1,
    template_id: "template-src",
    template_version_id: "template-version-src",
    template_name: "공정 운전 기록",
    template_revision_no: 1,
    approved_rules: 1,
    total_rules: 1,
    matched_sheets: [
      {
        role: "main",
        ordinal: 0,
        source_sheet: "공정 기록",
        source_sheet_id: "sheet-src",
        target_sheet: "공정 기록",
        target_sheet_id: f.ids.sheet,
      },
      {
        role: "common",
        ordinal: 0,
        source_sheet: "공통 정보",
        source_sheet_id: "common-src",
        target_sheet: "공통 정보",
        target_sheet_id: f.ids.common,
      },
    ],
    unmatched_roles: [],
    ...extra,
  };
}
const listing = (items: Row[], extra: Row = {}) => ({
  ...page(items),
  threshold: 0.5,
  signature_status: "ready",
  candidates: items.length,
  unsigned_candidates: 0,
  ...extra,
});

describe("같은 양식 문서군 제안", () => {
  it("점수순 목록과 매칭 시트를 표시한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    f.overrides.set(`GET /versions/${f.ids.version}/suggestions`, () =>
      listing([
        suggestion(f, 0.96),
        suggestion(f, 0.62, {
          source_application_id: "app-other",
          source_document_name: "다른 보고서.xlsx",
        }),
      ]),
    );
    render(<Workbench />);
    expect(await screen.findByText("같은 양식으로 보이는 문서군")).toBeTruthy();
    const meters = await screen.findAllByRole("meter", { name: "유사도" });
    expect(meters.map((m) => m.getAttribute("aria-valuenow"))).toEqual([
      "96",
      "62",
    ]);
    expect(
      screen.getAllByText(/main: 공정 기록 → 공정 기록/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/승인 규칙 1\/1/).length).toBe(2);
    expect(screen.getAllByText(/헤더 90% \(공통 라벨 5개\)/).length).toBe(2);
    expect(screen.getByText(/이전 보고서.xlsx · v1/)).toBeTruthy();
  });

  it("문서군이 없으면 안내 문구를 표시한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    render(<Workbench />);
    expect(
      await screen.findByText("비슷한 양식의 문서군이 없습니다."),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "선택한 문서군으로 등록 (검수 대기)",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("선택한 문서군으로 등록하면 검수 대기 적용 건을 만들고 원본 데이터로 이동한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    f.overrides.set(`GET /versions/${f.ids.version}/suggestions`, () =>
      listing([suggestion(f, 0.96)]),
    );
    f.overrides.set(
      `POST /versions/${f.ids.version}/applications/from-suggestion`,
      () => ({ application_id: "app-new", status: "proposed" }),
    );
    const user = userEvent.setup();
    render(<Workbench />);
    const item = await screen.findByRole("button", {
      name: /이전 보고서.xlsx · v1/,
    });
    await user.click(item);
    expect(item.getAttribute("aria-pressed")).toBe("true");
    await user.click(
      screen.getByRole("button", { name: "선택한 문서군으로 등록 (검수 대기)" }),
    );
    await waitFor(() => {
      const call = f.calls.find(
        (c) =>
          c.method === "POST" &&
          c.path === `/versions/${f.ids.version}/applications/from-suggestion`,
      );
      expect(call?.body).toEqual({ source_application_id: "app-src" });
    });
    await waitFor(() => {
      const params = new URLSearchParams(location.search);
      expect(params.get("tab")).toBe("source");
      expect(params.get("application")).toBe("app-new");
    });
  });

  it("미매칭 역할은 시트를 직접 골라 override로 보낸다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    const partial = suggestion(f, 0.7, { unmatched_roles: ["common"] });
    partial.matched_sheets[1] = {
      ...partial.matched_sheets[1],
      target_sheet: null,
      target_sheet_id: null,
    };
    f.overrides.set(`GET /versions/${f.ids.version}/suggestions`, () =>
      listing([partial]),
    );
    f.overrides.set(
      `POST /versions/${f.ids.version}/applications/from-suggestion`,
      () => ({ application_id: "app-new", status: "proposed" }),
    );
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByRole("button", { name: /이전 보고서.xlsx · v1/ }),
    );
    expect(screen.getByText(/common: 공통 정보 → 미매칭/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("common 시트"), f.ids.common);
    await user.click(
      screen.getByRole("button", { name: "선택한 문서군으로 등록 (검수 대기)" }),
    );
    await waitFor(() => {
      const call = f.calls.find(
        (c) =>
          c.method === "POST" &&
          c.path === `/versions/${f.ids.version}/applications/from-suggestion`,
      );
      expect(call?.body?.sheet_bindings).toEqual({
        main: [f.ids.sheet],
        common: [f.ids.common],
      });
    });
  });

  it("서명이 없으면 계산 버튼으로 서명을 만든 뒤 다시 조회한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    let signed = false;
    f.overrides.set(`GET /versions/${f.ids.version}/suggestions`, () =>
      signed
        ? listing([suggestion(f, 0.96)])
        : listing([], { signature_status: "missing" }),
    );
    f.overrides.set(`POST /versions/${f.ids.version}/signature`, () => {
      signed = true;
      return { status: "ready", cached: false };
    });
    const user = userEvent.setup();
    render(<Workbench />);
    expect(
      await screen.findByText("이 버전의 구조 서명이 없어 비교할 수 없습니다."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "구조 서명 계산" }));
    expect(
      await screen.findByRole("button", { name: /이전 보고서.xlsx · v1/ }),
    ).toBeTruthy();
    expect(
      f.calls.filter(
        (c) =>
          c.method === "POST" && c.path === `/versions/${f.ids.version}/signature`,
      ).length,
    ).toBe(1);
    expect(
      f.calls.filter(
        (c) =>
          c.method === "GET" &&
          c.path === `/versions/${f.ids.version}/suggestions`,
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("등록 실패 메시지를 표시한다", async () => {
    const f = workbenchFixture();
    f.open("documents");
    f.overrides.set(`GET /versions/${f.ids.version}/suggestions`, () =>
      listing([suggestion(f, 0.96)]),
    );
    f.overrides.set(
      `POST /versions/${f.ids.version}/applications/from-suggestion`,
      () => {
        throw new Error(
          "다음 시트 역할에 맞는 시트를 찾지 못했습니다: common(공통 정보)",
        );
      },
    );
    const user = userEvent.setup();
    render(<Workbench />);
    await user.click(
      await screen.findByRole("button", { name: /이전 보고서.xlsx · v1/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "선택한 문서군으로 등록 (검수 대기)" }),
    );
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((a) =>
            a.textContent?.includes(
              "다음 시트 역할에 맞는 시트를 찾지 못했습니다: common(공통 정보)",
            ),
          ),
      ).toBe(true),
    );
    expect(new URLSearchParams(location.search).get("tab")).toBe("documents");
  });
});
