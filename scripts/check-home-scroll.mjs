import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  for (const mobile of [false, true]) {
    for (const status of ["failed", "slow"]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile, hasTouch: mobile,
      });
      const page = await context.newPage();
      await page.route("**/activity/rows*", async (route) => {
        if (status === "failed") await route.abort();
        // Keep slow requests unresolved throughout the scrolling measurements.
      });
      const started = performance.now();
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator("#activity").waitFor();
      const navigation = await page.evaluate(() => {
        const timing = performance.getEntriesByType("navigation")[0];
        return { ttfbMs: timing.responseStart, domMs: timing.domContentLoadedEventEnd };
      });
      const height = await page.locator("#activity").evaluate((el) => el.getBoundingClientRect().height);
      assert(height > 0, "Feed must have space before status resolves");
      for (let visit = 0; visit < 3; visit++) {
        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
        if (mobile) {
          const session = await context.newCDPSession(page);
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: 650 }] });
          for (const y of [600, 500, 400, 300, 200]) {
            await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y }] });
          }
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await session.detach();
        } else {
          await page.mouse.move(400, 400);
          await page.mouse.wheel(0, 650);
        }
        await page.waitForFunction(() => scrollY > 20, null, { timeout: 1000 });
        const y = await page.evaluate(() => scrollY);
        assert(y > 20, "Scroll must respond while status is unavailable");
        if (visit < 2) {
          await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
          await page.locator('.site-header a[href="/projects"]').click();
          await page.waitForURL(/\/projects\/?$/, { waitUntil: "domcontentloaded" });
          await page.goBack({ waitUntil: "domcontentloaded" });
          await page.waitForURL(origin + "/", { waitUntil: "domcontentloaded" });
          await page.locator("#activity").waitFor();
        }
      }
      console.log(JSON.stringify({ mobile, status, ...navigation, feedHeight: height, totalMs: Math.round(performance.now() - started), navigations: 3 }));
      await context.close();
    }
  }
} finally {
  await browser.close();
}
