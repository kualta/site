import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const pause = (page, ms) => page.waitForTimeout(ms);
const position = (page) => page.evaluate(() => ({ y: scrollY, feed: Math.round(document.querySelector("#activity").getBoundingClientRect().top + scrollY) }));
async function at(page, target) {
  await page.waitForFunction((target) => Math.abs(scrollY - target) <= 2, target, { timeout: 2000 });
  await pause(page, 200);
  assert(Math.abs((await position(page)).y - target) <= 2, "Scroll must stay at its destination");
}
async function reset(page) {
  await pause(page, 200);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await at(page, 0);
}
async function swipe(context, page, points) {
  const session = await context.newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 195, y: points[0] }] });
  for (const y of points.slice(1)) {
    await pause(page, 25);
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 195, y }] });
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await session.detach();
}
function rows(extra = 0, tailHeight = 200, boundary = false) {
  return Array.from({ length: 20 + extra }, (_, i) => {
    const id = i - extra;
    const separator = boundary && id === 4
      ? '<li data-activity-boundary class="flex w-full items-center gap-3 py-1 text-xs text-secondary-text"><span class="h-px flex-1 bg-current opacity-20"></span><span>bluesky history ends here</span><span class="h-px flex-1 bg-current opacity-20"></span></li>'
      : "";
    return separator + `<li data-activity-row="fixture:${id}" style="height:${id === 19 ? tailHeight : 200}px;flex-shrink:0">Public row ${id}</li>`;
  }).join("");
}
function metadata() {
  return `<span hidden data-activity-meta data-server-now="${new Date().toISOString()}" data-fresh-until="${new Date(Date.now() + 300000).toISOString()}" data-delayed="false"></span>`;
}
try {
  for (const mobile of [false, true]) {
    for (const status of ["failed", "slow", "healthy"]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      let extra = 0;
      let tailHeight = 200;
      let boundary = false;
      let requests = 0;
      let releaseInitial;
      const initial = new Promise(resolve => { releaseInitial = resolve; });
      await page.route("**/activity/rows*", async route => {
        requests++;
        if (status === "failed") return route.abort();
        if (status === "slow") return;
        if (requests === 1) await initial;
        await route.fulfill({ contentType: "text/html", body: metadata() + rows(extra, tailHeight, boundary) });
      });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.locator("#activity").waitFor();
      await page.waitForFunction(() => document.querySelector("[data-activity-list]")?.dataset.activityReady === "true");
      await page.mouse.move(mobile ? 195 : 400, 400);
      const feed = (await position(page)).feed;
      const started = performance.now();
      if (mobile) await swipe(context, page, [650, 638, 626, 614]);
      else await page.mouse.wheel(0, 40);
      if (status === "healthy") releaseInitial();
      await at(page, feed);
      const transitionMs = Math.round(performance.now() - started - 200);
      if (status === "healthy") await page.waitForFunction(() => document.querySelector("[data-activity-list]").children.length === 20);
      assert.equal((await position(page)).y, feed, "Status arriving during the transition must not push into the feed");
      if (process.env.SCREENSHOT_DIR && status === "healthy") {
        await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/home-feed-${mobile ? "mobile" : "desktop"}.png` });
      }

      await reset(page);
      // A realistic decaying trackpad gesture must finish at the feed, not spend its tail below it.
      for (const delta of [12, 55, 100, 150, 90, 45, 18, 6]) {
        await page.mouse.wheel(0, delta);
        await pause(page, 35);
      }
      await at(page, feed);
      await reset(page);
      await page.mouse.wheel(0, 120);
      await page.waitForFunction(() => scrollY > 20);
      await page.mouse.wheel(0, -120);
      await at(page, 0);
      if (mobile) {
        await swipe(context, page, [650, 630, 610]);
        await swipe(context, page, [450, 470, 490]);
        await at(page, 0);
      }
      await pause(page, 500);
      assert.equal((await position(page)).y, 0, "Reversal must not leave a delayed downward push");
      await page.mouse.wheel(0, 40);
      await pause(page, 250); // The wheel has gone quiet, but the smooth transition is still running.
      await page.mouse.wheel(0, -40);
      await at(page, 0);

      // Native dialogs and nested scroll areas must retain their own wheel handling.
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.id = "dialog-fixture";
        dialog.innerHTML = '<div style="width:250px;height:150px">Media dialog</div>';
        document.body.append(dialog);
        dialog.showModal();
      });
      await page.locator("#dialog-fixture").hover();
      await page.mouse.wheel(0, 120);
      await pause(page, 400);
      assert.equal((await position(page)).y, 0, "A native modal must not start the background hero transition");
      await page.evaluate(() => document.querySelector("#dialog-fixture").remove());
      await page.evaluate(() => {
        const scroller = document.createElement("div");
        scroller.id = "scroll-fixture";
        scroller.style.cssText = "position:fixed;top:200px;left:100px;width:200px;height:100px;overflow-y:auto";
        scroller.innerHTML = '<div style="height:600px">Nested content</div>';
        document.body.append(scroller);
      });
      await page.locator("#scroll-fixture").hover();
      await page.mouse.wheel(0, 120);
      await pause(page, 250);
      assert(await page.locator("#scroll-fixture").evaluate(el => el.scrollTop > 0));
      assert.equal((await position(page)).y, 0);
      await page.evaluate(() => document.querySelector("#scroll-fixture").remove());
      await page.mouse.move(mobile ? 195 : 400, 400);

      await page.getByRole("link", { name: "Jump to recent activity" }).focus();
      await page.keyboard.press("Enter");
      await at(page, feed);
      await page.getByRole("button", { name: "Go back up" }).click();
      await at(page, 0);
      await page.keyboard.press("PageDown");
      await at(page, feed);
      await page.keyboard.press("Home");
      await at(page, 0);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.mouse.wheel(0, 40);
      await at(page, feed);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), "auto");
      await page.getByRole("button", { name: "Go back up" }).click();
      await at(page, 0);
      await page.emulateMedia({ reducedMotion: "no-preference" });

      if (status === "healthy") {
        await page.mouse.wheel(0, 40);
        await at(page, feed);
        await page.mouse.wheel(0, 250);
        await pause(page, 500);
        assert((await position(page)).y >= feed + 200, "A new gesture must freely scroll within the feed");
        await reset(page);
        for (let i = 0; i < 28; i++) {
          await page.mouse.wheel(0, 24);
          await pause(page, 45);
        }
        await pause(page, 300);
        assert((await position(page)).y > feed + 50, "Continuous input must be released within one second");
        if (mobile) {
          const before = (await position(page)).y;
          await swipe(context, page, [650, 610, 550, 490]);
          await pause(page, 500);
          assert((await position(page)).y > before + 50, "Feed touch scrolling must remain native");
        }
        // Keep the same row in view when new rows arrive above it.
        await page.evaluate(() => scrollTo({ top: document.querySelector("#activity").getBoundingClientRect().top + scrollY + 1000, behavior: "instant" }));
        await pause(page, 200);
        const anchor = await page.locator("[data-activity-list] > li").evaluateAll(elements => {
          const row = elements.find(el => el.getBoundingClientRect().bottom > 0);
          return { id: row.dataset.activityRow, top: row.getBoundingClientRect().top };
        });
        extra = 1;
        const previousRequests = requests;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.querySelector('[data-activity-row="fixture:-1"]'));
        assert(requests > previousRequests);
        const anchorTop = await page.locator(`[data-activity-row="${anchor.id}"]`).evaluate(el => el.getBoundingClientRect().top);
        assert(Math.abs(anchorTop - anchor.top) <= 2, "Prepending activity must preserve the visible row");
        const beforeTailChange = (await position(page)).y;
        tailHeight = 500;
        extra = 2; // Different signature forces replacement, including a taller off-screen tail.
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.querySelector('[data-activity-row="fixture:-2"]'));
        assert(Math.abs((await position(page)).y - beforeTailChange - 212) <= 2, "Only the row inserted above the viewport may move scroll position");

        // The history separator has no row ID; anchor the visible activity below it.
        boundary = true;
        extra = 3;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.querySelector('[data-activity-row="fixture:-3"]'));
        await page.evaluate(() => scrollTo({ top: document.querySelector("[data-activity-boundary]").getBoundingClientRect().top + scrollY + 8, behavior: "instant" }));
        await pause(page, 200);
        assert(await page.locator("[data-activity-list]").evaluate(list => {
          const firstVisible = [...list.children].find(el => el.getBoundingClientRect().bottom > 0);
          return firstVisible.hasAttribute("data-activity-boundary");
        }), "The separator must be the first visible child for this regression");
        const rowBelowBoundary = page.locator('[data-activity-row="fixture:4"]');
        const beforeBoundaryPoll = await rowBelowBoundary.evaluate(el => el.getBoundingClientRect().top);
        extra = 4;
        await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
        await page.waitForFunction(() => document.querySelector('[data-activity-row="fixture:-4"]'));
        await pause(page, 200);
        const boundaryDrift = await rowBelowBoundary.evaluate(el => el.getBoundingClientRect().top) - beforeBoundaryPoll;
        assert(Math.abs(boundaryDrift) <= 2, "Polling must preserve the visible row when the history separator is first visible");
        console.log(JSON.stringify({ mobile, separatorFirstVisible: true, prependedRowHeight: 212, rowDriftPx: boundaryDrift }));

        // Real generated HTML with warm feed fixtures lets Astro restore a deep reading position.
        await page.route(url => url.pathname === "/", async route => {
          const response = await route.fetch();
          const body = (await response.text()).replace(/(<ol[^>]*data-activity-list[^>]*>)[\s\S]*?<\/ol>/, `$1${rows(extra, tailHeight, boundary)}</ol>`);
          await route.fulfill({ response, body });
        });
        const restored = (await position(page)).y;
        // Clicking a link without scrollIntoView keeps the history entry's actual reading position.
        await page.evaluate(() => document.querySelector('.site-header a[href="/projects"]').click());
        await page.waitForURL(/\/projects\/?$/);
        await page.goBack();
        await page.waitForURL(url => url.pathname === "/");
        await at(page, restored);
        await page.goForward();
        await page.waitForURL(/\/projects\/?$/);
        await page.goBack();
        await page.waitForURL(url => url.pathname === "/");
        await at(page, restored);
        await reset(page);
        await page.mouse.wheel(0, 40);
        await at(page, (await position(page)).feed);
        await page.setViewportSize(mobile ? { width: 430, height: 932 } : { width: 1280, height: 900 });
        await pause(page, 500);
        await at(page, (await position(page)).feed);
      }
      console.log(JSON.stringify({ mobile, status, smallGestureSettledMs: transitionMs, feedTop: feed, trackpadMomentum: true, reversal: true, keyboard: true, reducedMotion: true, ...(status === "healthy" ? { feedScrolling: true, rowAnchoring: true, historyRestoration: true, resize: true } : {}) }));
      await context.close();
    }
  }
} finally { await browser.close(); }
