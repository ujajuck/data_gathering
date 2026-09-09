// 루트 / 와 /app 이 React 5탭을 서빙한다.
import { BASE, checker, launch } from "./helpers.mjs";

const { browser, page } = await launch();
const c = checker("shell");

for (const path of ["/", "/app/"]) {
  await page.goto(BASE + path + "?v1=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const text = await page.locator(".wk").textContent();
  c.ok(["1. 파일 분석", "2. 개념 탐색", "3. 원본 데이터", "4. 통합 DB",
        "5. 템플릿 관리"].every((t) => text.includes(t)),
       `${path} → 5탭 렌더`);
}
await browser.close();
c.done();
