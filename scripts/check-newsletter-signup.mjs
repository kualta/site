import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Exercise the real links page with intercepted requests: never create a subscriber.
const origin = process.argv[2] ?? "http://127.0.0.1:4321";
const shots = process.env.SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const scenarios = [
  { width: 1280, colorScheme: "dark", reducedMotion: "no-preference" },
  { width: 390, colorScheme: "light", reducedMotion: "no-preference" },
  { width: 320, colorScheme: "dark", reducedMotion: "reduce" },
  { width: 768, colorScheme: "light", reducedMotion: "reduce" },
];
try {
  for (const scenario of scenarios) {
    const context = await browser.newContext({
      colorScheme: scenario.colorScheme,
      reducedMotion: scenario.reducedMotion,
      viewport: { width: scenario.width, height: scenario.width <= 390 ? 844 : 900 },
      isMobile: scenario.width <= 390,
      hasTouch: scenario.width <= 390,
    });
    await context.addInitScript((theme) => localStorage.setItem("theme", theme), scenario.colorScheme);
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    let respond;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/subscribe", async (route) => {
      requests.push(route.request().postDataJSON());
      const response = await new Promise((resolve) => {
        respond = resolve;
      });
      if (response === "abort") await route.abort();
      else await route.fulfill({ contentType: "application/json", ...response });
    });
    const until = async (predicate) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await predicate()) return;
        await page.waitForTimeout(20);
      }
      assert.fail("Newsletter state did not settle");
    };
    const shot = async (state) => {
      if (shots) await page.screenshot({ path: path.join(shots, `${scenario.width}-${state}.png`), fullPage: true });
    };
    await page.goto(`${origin}/links`, { waitUntil: "networkidle" });
    await page.locator('astro-island[component-export="EmailSubscription"]:not([ssr])').waitFor();
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.locator("html").evaluate((el) => el.classList.contains("dark")),
      scenario.colorScheme === "dark",
    );
    const section = page.getByRole("region", { name: "newsletter" });
    const input = section.getByRole("textbox", { name: "Email address" });
    const button = section.locator('button[type="submit"]');
    const form = section.locator("form");
    const status = section.getByRole("status");
    const inputWidth = () => input.evaluate((el) => el.getBoundingClientRect().width);
    const fieldsWidth = await section.locator(".newsletter-fields").evaluate((el) => el.getBoundingClientRect().width);
    assert(Math.abs((await inputWidth()) - fieldsWidth) < 1, "Empty input fills its column");
    assert.equal(await section.getByRole("button").count(), 0, "Empty submit is hidden from accessibility tree");
    assert.equal(await page.locator(".newsletter-dock").count(), 0, "No duplicate corner form");
    const centered = await section.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const heading = el.querySelector("h2").getBoundingClientRect();
      return (
        Math.abs(rect.x + rect.width / 2 - innerWidth / 2) < 1 &&
        Math.abs(heading.x + heading.width / 2 - rect.x - rect.width / 2) < 1
      );
    });
    assert(centered, "Heading and form centered in the links column");
    await shot("empty");
    await input.focus();
    await input.press("Enter");
    assert.equal(await input.evaluate((el) => el.validity.valueMissing), true);
    await page.keyboard.press("Tab");
    assert.equal(await button.evaluate((el) => el === document.activeElement), false);

    await input.fill("reader@example.com");
    if (scenario.reducedMotion === "no-preference") {
      const widths = await input.evaluate(async (el) => {
        const values = [];
        for (let frame = 0; frame < 8; frame++) {
          await new Promise(requestAnimationFrame);
          values.push(el.getBoundingClientRect().width);
        }
        return values;
      });
      assert(
        widths.some((width) => width < fieldsWidth - 1 && width > fieldsWidth - 48),
        "Input animates through intermediate widths",
      );
    } else {
      assert.equal(await button.evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
    }
    await page.waitForTimeout(330);
    assert(Math.abs(fieldsWidth - (await inputWidth()) - 50.4) < 1, "Input yields space for compact button and gap");
    assert.equal(await section.getByRole("button", { name: "Subscribe", exact: true }).count(), 1);
    await shot("typed");
    await input.press("Tab");
    assert.equal(await button.evaluate((el) => el === document.activeElement), true);
    assert.notEqual(await button.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    await input.fill("");
    await page.waitForTimeout(330);
    assert(Math.abs((await inputWidth()) - fieldsWidth) < 1, "Clearing restores full width");
    assert.equal(await section.getByRole("button").count(), 0);
    assert.equal(await input.evaluate((el) => el === document.activeElement), true, "Clearing keeps input focus");
    await shot("cleared");
    // Retarget an interrupted transition, including its reverse direction.
    await input.fill("r");
    await page.waitForTimeout(40);
    await input.fill("");
    await page.waitForTimeout(40);
    await input.fill("invalid");
    await input.press("Enter");
    assert.equal(await input.evaluate((el) => el.validity.typeMismatch), true);
    assert.equal(requests.length, 0, "Native validation prevents invalid requests");

    await input.fill("reader@example.com");
    await input.press("Enter");
    await until(() => requests.length === 1 && respond);
    assert.deepEqual(requests[0], { email: "reader@example.com" });
    assert.equal(await form.getAttribute("aria-busy"), "true");
    assert.equal(await button.isDisabled(), true);
    assert.equal(await button.getAttribute("aria-label"), "Subscribing…");
    assert.equal(await input.getAttribute("readonly"), "");
    await input.press("Enter");
    assert.equal(requests.length, 1, "Pending Enter cannot duplicate submission");
    respond({ status: 503, body: JSON.stringify({ message: "Please try again." }) });
    await until(async () => (await status.textContent()) === "Please try again.");
    assert.equal(await input.inputValue(), "reader@example.com", "Failure preserves email");
    assert.equal(await button.isEnabled(), true);
    assert.equal(await input.getAttribute("readonly"), null);
    await shot("error");

    await button.click();
    await until(() => requests.length === 2);
    respond("abort");
    await until(async () => (await status.getAttribute("data-error")) === "true");
    assert.equal(await input.inputValue(), "reader@example.com", "Network failure preserves email");
    assert.equal(await button.isEnabled(), true);
    await button.click();
    await until(() => requests.length === 3);
    respond({ status: 200, body: JSON.stringify({ message: "You’re subscribed." }) });
    await until(async () => (await status.textContent()) === "You’re subscribed.");
    await page.waitForTimeout(330);
    assert.equal(await input.inputValue(), "");
    assert(Math.abs((await inputWidth()) - fieldsWidth) < 1, "Success reset restores full width");
    assert.equal(await button.isDisabled(), true);
    assert.equal(await form.getAttribute("aria-busy"), "false");
    assert.equal(await section.getByRole("button").count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await shot("success");
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log(
      JSON.stringify({
        ...scenario,
        states: "empty, typed, cleared, invalid, pending, server error, network error, success",
        requests: requests.length,
      }),
    );
    await context.close();
  }
  const page = await browser.newPage();
  for (const alias of ["contacts", "socials"]) {
    await page.goto(`${origin}/${alias}`, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("heading", { name: "newsletter", exact: true }).count(), 1);
    assert.equal(await page.locator(".newsletter-dock").count(), 0);
  }
  await page.goto(`${origin}/join`, { waitUntil: "networkidle" });
  assert.equal(
    await page.getByRole("button", { name: "Subscribe", exact: true }).count(),
    1,
    "Existing full form unchanged",
  );
  console.log("Aliases and existing /join form passed");
} finally {
  await browser.close();
}
