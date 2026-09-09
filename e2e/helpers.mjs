// E2E 공용 헬퍼 — Playwright 브라우저 기동과 판정 유틸.
// 브라우저 경로는 환경변수로 재정의할 수 있다 (기본: CCR 컨테이너 배치).
import { createRequire } from "module";

const PW = process.env.PLAYWRIGHT_INDEX
  || "/opt/node22/lib/node_modules/playwright/index.js";
const CHROMIUM = process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium";
export const BASE = process.env.KG_BASE_URL || "http://127.0.0.1:8010";

const require = createRequire(PW);
const { chromium } = require("playwright");

export async function launch() {
  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  return { browser, page };
}

export function checker(name) {
  const fails = [];
  return {
    ok(cond, msg) {
      console.log(`${cond ? "PASS" : "FAIL"} [${name}] ${msg}`);
      if (!cond) fails.push(msg);
    },
    done() {
      if (fails.length) {
        console.log(`\n[${name}] FAILURES: ${JSON.stringify(fails)}`);
        process.exitCode = 1;
      }
      return fails.length === 0;
    },
  };
}

export const active = (page) => page.locator(".screen.active");

export async function openTab(page, label) {
  await page.goto(BASE + "/?v1=1", { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  await page.locator("button", { hasText: label }).click();
  await page.waitForTimeout(700);
}

export async function clearCart(page) {
  await page.evaluate(() => localStorage.removeItem("kg_cart_v3"));
}

// 트리에서 개념 하나 체크(소스 fetch 대기 포함)
export async function checkConcept(page, name, waitMs = 2500) {
  await active(page).locator("label", { hasText: name }).first()
    .locator("input[type=checkbox]").click();
  await page.waitForTimeout(waitMs);
}
