import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

test("문서 → 검수 → 오버레이 → 추출 → DB·다운로드 → 원본 출처", async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon"))
      failures.push(message.text());
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Semantic Excel Integration");
  const nav = page.getByRole("navigation", { name: "작업 단계" });
  await expect(nav.getByRole("button")).toHaveText([
    "1. 파일 분석",
    "2. 개념 탐색",
    "3. 원본 데이터",
    "4. 통합 DB",
    "5. 템플릿 관리",
  ]);
  await expect(nav.getByRole("button", { name: "1. 파일 분석" })).toHaveCSS(
    "background-color",
    "rgb(53, 105, 232)",
  );
  const documents = page.locator("section").filter({
    has: page.getByRole("heading", { name: "등록 문서", exact: true }),
  });
  await page.getByText("문서 필터 · 정렬", { exact: true }).click();
  await page.getByLabel("추출 상태").selectOption("review");
  await expect(
    documents.getByRole("button", { name: /공정운전_샘플.xlsx/ }),
  ).toBeVisible();
  await documents.getByRole("button", { name: /공정운전_샘플.xlsx/ }).click();
  await page.getByRole("button", { name: /^공정 기록 ·/ }).click();
  const firstCell = page.getByRole("button", { name: /^B3:C3 공정$/ });
  await firstCell.focus();
  await firstCell.press("Enter");
  await expect(
    page.getByText("먼저 추출 규칙을 선택하세요.", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: /공정 운전 기록 · v1/ }).click();
  const inspector = page.locator(".v2-inspector");
  await expect(
    inspector.getByRole("button", { name: "main · B3:C3", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".v2-overlay.key")).toHaveCount(2);
  await expect(page.locator(".v2-overlay.value")).toHaveCount(1);
  // Exercise real hit testing across a merged key and its adjacent cell.
  await page.getByRole("button", { name: "키 선택", exact: true }).click();
  const dragFrom = await page
    .getByRole("button", { name: "B3:C3 공정", exact: true })
    .boundingBox();
  const dragTo = await page
    .getByRole("button", { name: "D3 온도", exact: true })
    .boundingBox();
  expect(dragFrom).not.toBeNull();
  expect(dragTo).not.toBeNull();
  await page.mouse.move(
    dragFrom!.x + dragFrom!.width / 2,
    dragFrom!.y + dragFrom!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    dragTo!.x + dragTo!.width / 2,
    dragTo!.y + dragTo!.height / 2,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(
    inspector.getByText("key · B3:D3", { exact: true }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "이 영역 추가", exact: true })
    .click();
  await expect(page.locator(".v2-overlay.key")).toHaveCount(3);
  await inspector
    .getByRole("button", { name: "key 영역 3 삭제", exact: true })
    .click();
  await expect(page.locator(".v2-overlay.key")).toHaveCount(2);
  await page.getByLabel("원본 주소 이동").fill("A45");
  await page.getByRole("button", { name: "이동", exact: true }).click();
  await expect(page).toHaveURL(/row=45/);
  await expect(page.getByRole("button", { name: /^B45:C45 / })).toBeVisible();
  await expect(page.locator(".v2-overlay.value")).toHaveCount(1);
  await page.getByLabel("확대 배율").selectOption("0.5");
  await expect(page.locator(".v2-sheet")).toHaveCSS(
    "transform",
    "matrix(0.5, 0, 0, 0.5, 0, 0)",
  );
  await inspector.getByLabel("저장 상태").selectOption("approved");
  await inspector.getByRole("button", { name: "수정 버전 저장" }).click();
  await expect(inspector.locator(".v2-badge").first()).toHaveText("r2");
  await page.getByRole("button", { name: "승인한 규칙으로 추출" }).click();
  const extracted = page.locator("section").filter({
    has: page.getByRole("heading", {
      name: "추출값 · 원본 출처",
      exact: true,
    }),
  });
  await extracted.getByRole("button", { name: /공정온도/ }).click();
  await expect(extracted.getByRole("row")).toHaveCount(31);
  const items = extracted
    .locator("div")
    .filter({
      has: page.getByRole("heading", { name: "항목별 값", exact: true }),
    })
    .last();
  await items.getByRole("button", { name: "다음", exact: true }).click();
  await expect(
    extracted.getByRole("row").filter({ hasText: "LOT-031" }),
  ).toBeVisible();
  await extracted
    .getByRole("row")
    .filter({ hasText: "LOT-031" })
    .getByRole("button")
    .click();
  await expect(
    extracted.getByRole("button", { name: /공통 정보!B1/ }),
  ).toBeVisible();
  await expect(
    extracted.getByRole("button", { name: /record_key/ }),
  ).toHaveCount(1);

  await nav.getByRole("button", { name: "4. 통합 DB" }).click();
  await page
    .getByText("개념 트리 · 하위 개념 일괄 선택", { exact: true })
    .click();
  await page.getByRole("checkbox", { name: "공정온도", exact: true }).check();
  await page
    .getByRole("button", { name: "선택한 개념의 소스 모두 추가" })
    .click();
  await page.getByLabel("출력 열 이름").fill("운전 온도");
  await page.getByLabel("행 결합 방식").selectOption("record_scope");
  await page.getByRole("button", { name: "통합 명세 저장 · DB 생성" }).click();
  const preview = page.locator("section").filter({
    has: page.getByRole("heading", { name: "결과 미리보기", exact: true }),
  });
  await expect(
    preview.getByRole("row").filter({ hasText: "LOT-001" }),
  ).toBeVisible();
  for (const [label, format] of [
    ["SQLite 다운로드", "sqlite"],
    ["CSV 다운로드", "csv"],
  ]) {
    const waiting = page.waitForEvent("download");
    await page.getByRole("button", { name: label, exact: true }).click();
    const download = await waiting;
    const path = testInfo.outputPath(`result.${format}`);
    await download.saveAs(path);
    if (format === "csv") {
      const csv = await readFile(path, "utf8");
      expect(csv).toContain("_record_key");
      expect(csv).toContain("LOT-001");
      expect(csv.split("\r\n").filter(Boolean)).toHaveLength(66);
    } else {
      // Inspect the downloaded artifact, not the server's internal DB.
      const result = JSON.parse(
        execFileSync(
          process.env.KG_E2E_PYTHON || "python",
          [
            "-c",
            "import json,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(json.dumps(c.execute('SELECT count(*),min(_record_key),max(_record_key) FROM data').fetchone()))",
            path,
          ],
          { encoding: "utf8" },
        ),
      );
      expect(result).toEqual([65, "LOT-001", "LOT-065"]);
    }
  }
  await preview.getByRole("button", { name: "다음", exact: true }).click();
  await preview
    .getByRole("row")
    .filter({ hasText: "LOT-031" })
    .getByRole("button")
    .click();
  await preview.getByRole("button", { name: /^value/ }).click();
  await preview.getByRole("button", { name: /공통 정보!B1/ }).click();
  await expect(
    page.getByRole("button", { name: "B1 °C", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/tab=source/);
  await expect(page).toHaveURL(/row=1/);
  await expect(page.locator(".v2-overlay.focus")).toHaveCount(1);
  await page.screenshot({
    path: testInfo.outputPath("source-lineage.png"),
    fullPage: true,
  });
  expect(failures).toEqual([]);
});

test("개념 그래프 · 문서군 제안 · 재크롤링 화면", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("favicon"))
      failures.push(message.text());
  });
  await page.goto("/");
  // 개념 탐색: 커버리지 그래프 카드가 v1처럼 그려지고, L1만 있는 KG도 hull로 보인다.
  await page.getByRole("button", { name: "2. 개념 탐색" }).click();
  const graph = page.getByLabel("전체 개념 트리와 문서군 커버리지");
  await expect(graph).toBeVisible();
  await expect(graph.locator(".hull")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^문서군 공정온도/ })).toBeVisible();
  await page.getByRole("button", { name: "그래프 확대" }).click();
  await expect(page.getByRole("button", { name: "원래 크기로" })).toHaveText("125%");
  await page.getByRole("button", { name: "목록", exact: true }).click();
  await expect(graph).toHaveCount(0);

  // 파일 분석: 문서 하나뿐이라 같은 양식 제안은 빈 상태를 보여준다.
  await page.getByRole("button", { name: "1. 파일 분석" }).click();
  const documents = page.locator("section").filter({
    has: page.getByRole("heading", { name: "등록 문서", exact: true }),
  });
  await documents.getByRole("button", { name: /공정운전_샘플.xlsx/ }).click();
  await expect(page.locator(".v2-suggestions")).toBeVisible();
  await expect(page.locator(".v2-suggestions")).toContainText(/양식/);
  await expect(
    page.getByRole("button", { name: /선택한 문서군으로 등록/ }),
  ).toBeDisabled();

  // 템플릿 관리: 재크롤링은 검수 미완/발행됨 건을 건너뛴 결과를 보여준다.
  await page.getByRole("button", { name: "5. 템플릿 관리" }).click();
  await page.getByRole("button", { name: /공정 운전 기록/ }).first().click();
  const recrawl = page.locator(".v2-recrawl");
  await expect(recrawl).toBeVisible();
  await recrawl.getByRole("button", { name: "실행", exact: true }).click();
  await expect(recrawl.getByRole("status")).toContainText(/대기열 \d+건 · 건너뜀 \d+건/);
  expect(failures).toEqual([]);
});
