// 통합 DB: 개념 트리 일괄 선택 → 생성 → .db/.csv 다운로드 검증.
import { active, checkConcept, checker, clearCart, launch, openTab }
  from "./helpers.mjs";

const { browser, page } = await launch();
const c = checker("tree-build");
await openTab(page, "4. 통합 DB");
await clearCart(page);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("button", { hasText: "4. 통합 DB" }).click();
await page.waitForTimeout(700);

// 상위 개념 체크 → 하위 일괄
await checkConcept(page, "실험조건", 4000);
const childCb = active(page).locator("label", { hasText: "오븐온도" }).first()
  .locator("input[type=checkbox]");
c.ok(await childCb.isChecked(), "상위 체크 → 하위 자동 체크");
const cartConcepts = await page.evaluate(() =>
  new Set(JSON.parse(localStorage.getItem("kg_cart_v3") || "[]")
    .map((x) => x.concept_id)).size);
c.ok(cartConcepts > 3, `여러 하위 개념 담김 (${cartConcepts}개)`);

// 부분 해제 → indeterminate
await childCb.click();
await page.waitForTimeout(800);
const parentState = await active(page).locator("label", { hasText: "실험조건" })
  .first().locator("input[type=checkbox]")
  .evaluate((el) => ({ checked: el.checked, ind: el.indeterminate }));
c.ok(!parentState.checked && parentState.ind, "부분 선택 시 상위 indeterminate");
await childCb.click();                       // 원상 복구
await page.waitForTimeout(1500);

// 생성 → 다운로드
await active(page).locator("button", { hasText: "DB 생성" }).click();
await page.waitForTimeout(6000);
const text = await active(page).textContent();
c.ok(text.includes("생성 완료"), "빌드 완료");
const hrefs = await active(page).locator("a[href*='/api/build/']")
  .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
c.ok(hrefs.length === 2, "다운로드 링크 2종");
for (const h of hrefs) {
  const r = await page.evaluate(async (u) => {
    const res = await fetch(u);
    const buf = await res.arrayBuffer();
    return { status: res.status, bytes: buf.byteLength,
             head: String.fromCharCode(...new Uint8Array(buf.slice(0, 15))) };
  }, h);
  if (h.includes("csv")) c.ok(r.status === 200 && r.bytes > 100, "CSV 반환");
  else c.ok(r.status === 200 && r.head.startsWith("SQLite format 3"),
            "SQLite 파일 반환");
}
await browser.close();
c.done();
