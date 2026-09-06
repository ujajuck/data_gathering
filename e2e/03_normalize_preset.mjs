// 정규화 프리셋: '195 ℃' 혼합 텍스트가 '값·단위 분리' 프리셋으로 숫자가 된다.
import { active, checkConcept, checker, clearCart, launch, openTab }
  from "./helpers.mjs";

const { browser, page } = await launch();
const c = checker("normalize");
await openTab(page, "4. 통합 DB");
await clearCart(page);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("button", { hasText: "4. 통합 DB" }).click();
await page.waitForTimeout(700);

await checkConcept(page, "오븐온도", 2500);

// 양식 카드 전처리 드롭다운에 normalizers.yaml 프리셋 노출
const prepSel = active(page).locator(".dkgCard select").first();
const opts = await prepSel.locator("option").allTextContents();
c.ok(opts.some((o) => o.includes("값·단위 분리")), "프리셋 드롭다운 노출");

// 기준선: 자동 정규화 → '195 ℃' 텍스트 잔존
await active(page).locator("button", { hasText: "DB 생성" }).click();
await page.waitForTimeout(5000);
let preview = await active(page).locator("tbody").last().textContent();
c.ok(preview.includes("195 ℃"), "기준선: 혼합 표기 텍스트 잔존");

// 프리셋 적용 → 재생성 → 숫자화 (미리보기 + CSV)
const idx = opts.findIndex((o) => o.includes("값·단위 분리"));
await prepSel.selectOption({ index: idx });
await page.waitForTimeout(800);
await active(page).locator("button", { hasText: "다시 생성" }).click();
await page.waitForTimeout(5000);
preview = await active(page).locator("tbody").last().textContent();
c.ok(!preview.includes("195 ℃") && preview.includes("195"),
     "프리셋 적용 후 '195 ℃' → 195");
const csvHref = await active(page).locator("a[href*='format=csv']")
  .getAttribute("href");
const csv = await page.evaluate(async (u) => (await fetch(u)).text(), csvHref);
c.ok(!csv.includes("195 ℃") && csv.includes("195"), "CSV 산출물에도 반영");

await browser.close();
c.done();
