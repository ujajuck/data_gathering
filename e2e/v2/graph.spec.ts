import { test, expect } from "@playwright/test";

test("KG 이웃 페이지 · 방향 관계 · 확대/드래그 · 딥링크", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  const children = Array.from(
    { length: 35 },
    (_, n) => `field_${String(n).padStart(2, "0")}`,
  );
  const response = await page.request.post("/api/v2/kg/import", {
    data: {
      concepts: [
        { concept_id: "root", name: "공정 분류", level: 1 },
        ...children.map((id) => ({
          concept_id: id,
          name: `항목 ${id.slice(-2)}`,
          level: 2,
        })),
      ],
      relations: [
        ...children.map((id) => ["root", id, "parent_of"]),
        [children[0], children[1], "related"],
      ],
    },
  });
  expect(response.ok()).toBeTruthy();
  const kg = (await response.json()).kg_revision_id;
  await page.goto(`/?v2=1&tab=kg&kg=${kg}&graph_focus=root&coverage=none`);
  const graph = page.getByRole("region", { name: "KG 커버리지 그래프" });
  const canvas = graph.locator(".v2-kg-canvas");
  await expect(canvas.getByRole("button")).toHaveCount(31);
  await expect(canvas.locator(".v2-kg-edge.hierarchy")).toHaveCount(30);
  await expect(canvas.locator(".v2-kg-edge.related")).toHaveCount(1);
  await graph.getByLabel("그래프 확대").selectOption("0.5");
  await expect(canvas.locator("svg")).toHaveAttribute("width", "283");
  await graph.getByLabel("그래프 확대").selectOption("1");
  // 실제 빈 공간 포인터 이동이 스크롤을 바꾸는지 검사한다.
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 400);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 40, box!.y + 180, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() => canvas.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(100);
  await graph
    .getByRole("group", { name: "그래프 페이지" })
    .getByRole("button", { name: "다음", exact: true })
    .click();
  await expect(canvas.getByRole("button")).toHaveCount(6);
  const node = canvas.getByRole("button", { name: /^항목 34 ·/ });
  await node.focus();
  await node.press("Space");
  await expect(
    page
      .getByRole("region", { name: "선택 개념 상세" })
      .getByRole("heading", { name: "항목 34", exact: true }),
  ).toBeVisible();
  await graph.getByRole("button", { name: "선택 개념 주변" }).click();
  await expect(page).toHaveURL(/graph_focus=field_34/);
  await expect(canvas.getByRole("button")).toHaveCount(2);
  await page.reload();
  await expect(
    canvas.getByRole("button", { name: /^항목 34 ·/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(canvas.getByRole("button")).toHaveCount(2);
  await graph.screenshot({ path: testInfo.outputPath("kg-coverage.png") });
  expect(errors).toEqual([]);
});
