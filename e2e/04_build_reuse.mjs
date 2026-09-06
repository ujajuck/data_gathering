// 증분 빌드: 선택·원본이 그대로면 재생성이 이전 산출물을 즉시 재사용한다.
import { active, checkConcept, checker, clearCart, launch, openTab }
  from "./helpers.mjs";

const { browser, page } = await launch();
const c = checker("reuse");
await openTab(page, "4. 통합 DB");
await clearCart(page);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.locator("button", { hasText: "4. 통합 DB" }).click();
await page.waitForTimeout(700);

await checkConcept(page, "오븐온도", 2500);
await active(page).locator("button", { hasText: "DB 생성" }).click();
await page.waitForTimeout(5000);
c.ok((await active(page).textContent()).includes("생성 완료"), "1차 빌드 완료");
const firstDl = await active(page).locator("a[href*='/api/build/']").first()
  .getAttribute("href");

// 아무것도 안 바꾸고 재생성 → 즉시 재사용 (같은 build_id)
const t0 = Date.now();
await active(page).locator("button", { hasText: "다시 생성" }).click();
await page.waitForFunction(
  () => document.body.textContent.includes("이전 빌드를 즉시 재사용"),
  { timeout: 8000 }).catch(() => {});
const elapsed = (Date.now() - t0) / 1000;
const text = await active(page).textContent();
c.ok(text.includes("이전 빌드를 즉시 재사용"), "무변경 재생성 → 재사용 안내");
c.ok(elapsed < 5, `재사용 응답 빠름 (${elapsed.toFixed(1)}s)`);
const secondDl = await active(page).locator("a[href*='/api/build/']").first()
  .getAttribute("href");
c.ok(firstDl === secondDl, "같은 산출물(build_id) 재사용");

// 선택을 바꾸면 재계산 (재사용 문구 없음)
await checkConcept(page, "부재료", 2500);
await active(page).locator("button", { hasText: "다시 생성" }).click();
await page.waitForTimeout(5000);
const text2 = await active(page).textContent();
c.ok(!text2.includes("이전 빌드를 즉시 재사용") && text2.includes("생성 완료"),
     "선택 변경 → 재계산");
c.ok((await active(page).locator("a[href*='/api/build/']").first()
      .getAttribute("href")) !== firstDl, "새 build_id 발급");

await browser.close();
c.done();
