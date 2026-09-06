// 템플릿 관리: 생성 → 같은 문서에 2개 배정(N:M) → 해제 독립성.
// DB를 변조하므로 run_all.mjs가 kg.db를 백업/원복한다.
import { active, checker, launch, openTab } from "./helpers.mjs";

const { browser, page } = await launch();
const c = checker("templates-nm");
const SPEC = JSON.stringify({ sheet_templates: [{ name: "any",
  match: { name_regex: ".*" },
  mappings: [{ key: "probe", concept_id: "oven_temperature",
    source: { range: "B2:B2" }, type: "number" }] }] });

await openTab(page, "5. 템플릿 관리");
for (const [id, name] of [["tpl_e2e_a", "관점A"], ["tpl_e2e_b", "관점B"]]) {
  await active(page).locator("button", { hasText: "+ 새 템플릿" }).click();
  await active(page).locator('input[placeholder^="template_id"]').fill(id);
  await active(page).locator('input[placeholder="이름"]').fill(name);
  await active(page).locator("textarea").last().fill(SPEC);
  await active(page).locator("button", { hasText: /^생성$/ }).click();
  await page.waitForTimeout(800);
}
const list = await active(page).locator("table").first().textContent();
c.ok(list.includes("관점A") && list.includes("관점B"), "템플릿 2개 생성");

for (const name of ["관점A", "관점B"]) {
  await active(page).locator("table tr", { hasText: name }).first().click();
  await page.waitForTimeout(700);
  await active(page).locator("select").last().selectOption({ index: 1 });
  await active(page).locator("button", { hasText: "배정" }).last().click();
  await page.waitForTimeout(800);
}
c.ok((await active(page).textContent()).includes("배정된 문서 (1)"),
     "같은 문서에 두 번째 템플릿도 배정 (N:M)");

await active(page).locator("table tr", { hasText: "관점A" }).first().click();
await page.waitForTimeout(700);
await active(page).locator("button", { hasText: "해제" }).first().click();
await page.waitForTimeout(800);
c.ok((await active(page).textContent()).includes("배정된 문서가 없습니다"),
     "해제 동작");
await active(page).locator("table tr", { hasText: "관점B" }).first().click();
await page.waitForTimeout(700);
c.ok((await active(page).textContent()).includes("배정된 문서 (1)"),
     "다른 템플릿 배정은 유지 (독립성)");

await browser.close();
c.done();
