import assert from "node:assert/strict";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
const root = process.cwd();
const server = await createServer({
  configFile: false,
  root: path.join(root, "scripts/browser-fixtures"),
  resolve: {
    alias: [
      { find: "@/lib/bluesky/auth", replacement: path.join(root, "scripts/browser-fixtures/feed-auth.ts") },
      { find: "@", replacement: path.join(root, "src") },
    ],
  },
  esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 8798, fs: { allow: [root] } },
});
await server.listen();
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH });
const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const uri = `at://${did}/app.bsky.feed.post/fixture1`;
const cid = "bafyreid3l3mpwbadpafmoajnc2ukaaf42cmnti6shcomrrqnqq4ctap5xy";
const row = (id, time, content, postUri, action = "post", postCid = cid) =>
  `<li data-activity-row="${id}" data-activity-occurred-at="${time}"><article ${
    postUri ? `data-post-uri="${postUri}" data-post-cid="${postCid}" data-post-action="${action}"` : ""
  }>${content}</article></li>`;
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      isMobile: mobile,
      hasTouch: mobile,
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await page.route("**/post/**/row", (route) => route.fulfill({ status: 503, body: "Indexing unavailable" }));
    await page.goto("http://127.0.0.1:8798");
    await page.getByRole("textbox", { name: "Write a Bluesky post" }).fill("Actual acknowledged post");
    const image = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 4;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "red";
      ctx.fillRect(0, 0, 4, 4);
      return canvas.toDataURL("image/png").split(",")[1];
    });
    await page
      .locator('input[type="file"][accept^="image/jpeg"]')
      .setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
    await page.getByRole("textbox", { name: "Media description" }).fill("Actual attached image");
    await page.evaluate(() => (window.failPost = true));
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Write a Bluesky post" }).inputValue(),
      "Actual acknowledged post",
    );
    assert.equal(await page.locator("ol article").count(), 0);
    assert.equal(await page.getByRole("textbox", { name: "Media description" }).inputValue(), "Actual attached image");
    await page.evaluate(() => (window.failPost = false));
    const start = Date.now();
    await page.getByRole("button", { name: "Post", exact: true }).click();
    await page.locator("ol article").waitFor();
    const submitToVisibleMs = Date.now() - start;
    const acknowledgedMs = await page.evaluate(() => performance.now() - window.ackAt);
    assert.equal(await page.locator("ol article p").first().textContent(), "Actual acknowledged post");
    assert.equal(await page.getByRole("textbox", { name: "Write a Bluesky post" }).inputValue(), "");
    assert.equal(await page.evaluate(() => window.written.text), "Actual acknowledged post");
    assert.equal(await page.locator('ol img[alt="Actual attached image"]').count(), 1);
    assert.equal(await page.evaluate(() => window.written.embed.images[0].alt), "Actual attached image");
    await page.getByRole("button", { name: "Post options" }).click();
    await page.getByRole("button", { name: "Copy kualta.dev link" }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      `https://kualta.dev/post/${encodeURIComponent(did)}/fixture1`,
    );
    await page.getByRole("button", { name: "Post options" }).click();
    await page.getByRole("button", { name: "Copy Bluesky link" }).click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      `https://bsky.app/profile/${did}/post/fixture1`,
    );
    await page.evaluate(() =>
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: async () => {
          throw new Error("Denied");
        },
        configurable: true,
      }),
    );
    await page.getByRole("button", { name: "Post options" }).click();
    await page.getByRole("button", { name: "Copy kualta.dev link" }).click();
    await page.getByRole("link", { name: "Open this post" }).waitFor();
    assert.match(
      await page
        .locator('[role="status"]')
        .allTextContents()
        .then((x) => x.join(" ")),
      /Could not copy/,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".post-menu-trigger")?.getAttribute("aria-expanded") === "false");
    assert.equal(await page.getByRole("button", { name: "Post options" }).getAttribute("aria-expanded"), "false");
    await page.evaluate(
      (html) => window.reconcile(html),
      '<li data-activity-row="github-same" data-activity-count="1" data-activity-occurred-at="2099-01-01T00:00:00Z">One event</li>',
    );
    await page.evaluate(
      (html) => window.reconcile(html),
      '<li data-activity-row="github-same" data-activity-count="2" data-activity-occurred-at="2099-01-01T00:00:00Z">Two events</li>',
    );
    assert.match(await page.locator("ol").textContent(), /Two events/);
    const time = await page.evaluate(() => window.written.createdAt);
    const old = new Date(Date.parse(time) - 60_000).toISOString();
    await page.evaluate((html) => window.reconcile(html), row("older", old, "Earlier activity"));
    assert.equal(await page.locator("ol article").count(), 2);
    await page.evaluate(
      (html) => window.reconcile(html),
      row("canonical", time, "Canonical actual post", uri) + row("older", old, "Earlier activity"),
    );
    assert.equal(await page.locator(`[data-post-uri="${uri}"]`).count(), 1);
    await page.evaluate((html) => window.older(html), row("duplicate", time, "Duplicate", uri));
    assert.equal(await page.locator(`[data-post-uri="${uri}"]`).count(), 1);
    // A retained older canonical must not become the replacement boundary.
    await page.evaluate(
      ({ head, middle, canonical }) => {
        document.querySelector("ol").innerHTML = head + middle + canonical;
      },
      {
        head: row("head", new Date(Date.parse(time) + 120_000).toISOString(), "Head"),
        middle: row("middle", new Date(Date.parse(time) + 60_000).toISOString(), "Loaded middle history"),
        canonical: row("canonical", time, "Canonical actual post", uri).replace(
          "<li ",
          '<li data-activity-cursor="old-local-cursor" ',
        ),
      },
    );
    await page.evaluate(
      (html) => window.reconcile(html),
      row("head", new Date(Date.parse(time) + 120_000).toISOString(), "Head refreshed"),
    );
    assert.match(await page.locator("ol").textContent(), /Loaded middle history/);
    const retainedCursor = await page
      .locator(`[data-post-uri="${uri}"]`)
      .locator("..")
      .getAttribute("data-activity-cursor");
    // A real history row keeps its cursor; after navigation a retained-only row cannot advance pagination.
    await page.evaluate(() => window.navigate());
    assert.equal(
      await page.locator(`[data-post-uri="${uri}"]`).locator("..").getAttribute("data-activity-cursor"),
      null,
    );
    for (let i = 0; i < 3; i++) await page.evaluate(() => window.navigate());
    assert.equal(await page.locator(`[data-post-uri="${uri}"]`).count(), 1);
    console.log(
      JSON.stringify({
        mobile,
        submitToVisibleMs,
        acknowledgedMs,
        failedWriteRetainsDraft: true,
        failedIndexingKeepsPost: true,
        copyLinks: true,
        staleRefreshAndHistoryDeduplicate: true,
        repeatedNavigation: true,
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
