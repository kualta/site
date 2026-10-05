import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
});
try {
  for (const mobile of [false, true]) {
    for (const skew of [-20 * 60_000, 20 * 60_000]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile,
        hasTouch: mobile,
      });
      const page = await context.newPage();
      const now = Date.now();
      await page.clock.install({ time: now + skew });
      let fail = false;
      let stale = false;
      let hanging = false;
      let requests = 0;
      let releaseInitial;
      const initialRead = new Promise((resolve) => (releaseInitial = resolve));
      await page.route("**/activity/rows*", async (route) => {
        requests++;
        if (requests === 1) await initialRead;
        if (hanging) return;
        if (fail) return route.fulfill({ status: 503, body: "Cache unavailable" });
        const current = now + (await page.evaluate(() => performance.now()));
        const seen = new Date(current).toISOString();
        const fresh = new Date(current + (stale ? -1 : 300_000)).toISOString();
        const trusted = new Date(current + 86_400_000).toISOString();
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: `<span hidden data-activity-meta data-server-now="${new Date(
            current,
          ).toISOString()}" data-last-seen="${seen}" data-fresh-until="${fresh}" data-trusted-until="${trusted}" data-delayed="${stale}"></span>`,
        });
      });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      assert.equal(
        await page.locator("[data-signals-delayed]").evaluate((el) => el.hidden),
        false,
        "A behind clock must not hide the server's delayed state",
      );
      releaseInitial();
      // Run against a local cold cache: a delayed arrival should read again now.
      await page.waitForFunction(() => document.querySelector("[data-signals-delayed]")?.hidden, null, {
        timeout: 3000,
      });
      assert(requests > 0, "Cold arrival must re-read the shared snapshot immediately");
      const seen = await page.locator("[data-activity-widget]").getAttribute("data-last-seen");
      fail = true;
      await page.clock.setFixedTime(new Date(now - skew * 3));
      assert.equal(
        await page.locator("[data-signals-delayed]").evaluate((el) => el.hidden),
        true,
        "Wall-clock corrections must not change freshness",
      );
      await page.clock.fastForward(301_000);
      await page.waitForFunction(() => !document.querySelector("[data-signals-delayed]")?.hidden);
      assert.equal(
        await page.locator("[data-activity-widget]").getAttribute("data-last-seen"),
        seen,
        "Failed poll must preserve successful data",
      );
      fail = false;
      await page.waitForFunction(
        () => document.querySelector("[data-activity-list]")?.dataset.activityPolling !== "true",
      );
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.waitForFunction(() => document.querySelector("[data-signals-delayed]")?.hidden);
      const refresh = page.getByRole("button", { name: "Refresh activity" });
      const feedback = page.locator("[data-activity-refresh-status]");
      await page.waitForFunction(() => document.querySelector("[data-activity-list]")?.dataset.activityPolling !== "true");
      stale = true;
      await refresh.click();
      await page.waitForFunction(() => document.querySelector("[data-activity-refresh-status]")?.textContent.includes("still delayed"));
      assert.equal(await page.locator("[data-signals-delayed]").evaluate(el => el.hidden), false);
      stale = false;
      fail = true;
      await refresh.click();
      await page.waitForFunction(() => document.querySelector("[data-activity-refresh-status]")?.textContent.includes("could not refresh"));
      assert.equal(await refresh.isEnabled(), true);
      fail = false;
      await refresh.click();
      await page.waitForFunction(() => document.querySelector("[data-activity-refresh-status]")?.textContent === "Activity refreshed.");
      if (skew > 0) {
        hanging = true;
        const timeoutStarted = Date.now();
        await refresh.click();
        assert.match(await feedback.textContent(), /Refreshing activity/);
        assert.equal(await refresh.isEnabled(), false);
        await page.mouse.wheel(0, 500);
        await page.waitForFunction(() => scrollY > 20, null, { timeout: 1000 });
        await page.waitForFunction(() => document.querySelector("[data-activity-refresh-status]")?.textContent.includes("could not refresh"), null, { timeout: 10_000 });
        assert(Date.now() - timeoutStarted < 10_000);
        assert.equal(await refresh.isEnabled(), true);
      }
      console.log(
        JSON.stringify({
          mobile,
          skewMinutes: skew / 60_000,
          coldRecovery: true,
          delayedAfterFiveMinutes: true,
          failedPollRetainsSnapshot: true,
          successfulRecovery: true,
          manualFeedback: true,
          ...(skew > 0 ? { boundedManualTimeoutAndResponsiveScroll: true } : {}),
          requests,
        }),
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
}
