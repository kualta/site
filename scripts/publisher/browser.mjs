import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Innertube } from "youtubei.js";

export const destinations = {
  twitter: "https://x.com/home",
  instagram: "https://www.instagram.com/",
  youtube: "https://www.youtube.com/",
  tiktok: "https://www.tiktok.com/tiktokstudio/upload",
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
};
// RedNote, Xiaohongshu's international site, signs accounts in on rednote.com, and that
// session doesn't open xiaohongshu.com: publish where the profile is signed in.
const rednote = "https://creator.rednote.com/publish/publish";
export async function destination(platform, context) {
  if (platform !== "xiaohongshu") return destinations[platform];
  const cookies = await context.cookies(rednote);
  return cookies.some((cookie) => cookie.name === "web_session" && cookie.value) ? rednote : destinations.xiaohongshu;
}
/** The upload page layers a transparent copy of each tab under the real one, which takes the clicks. */
export async function clickUploadTab(page, label) {
  const tabs = page.locator(".creator-tab").filter({ hasText: label });
  await tabs.first().waitFor();
  for (const tab of await tabs.all())
    if (await tab.evaluate((el) => Number(getComputedStyle(el).opacity) > 0.5)) return tab.click();
  throw new Error(`Xiaohongshu's ${label} tab is not showing`);
}
export async function openProfile(path, headless = false) {
  return chromium.launchPersistentContext(path, {
    channel: "chrome",
    // Match ordinary Chrome so saved login cookies use the same OS keychain.
    ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
    headless,
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
}
function findId(value, names) {
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (names.includes(key) && typeof item === "string" && /^[\w-]{8,64}$/.test(item)) return item;
    const nested = findId(item, names);
    if (nested) return nested;
  }
  return null;
}
export async function publishBrowser(platform, profile, files, post) {
  const context = await openProfile(profile);
  try {
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(60_000);
    if (platform === "youtube") {
      const cookies = await context.cookies("https://www.youtube.com");
      let cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      if (!cookies.some((c) => c.name === "SAPISID")) {
        const fallback = cookies.find((c) => c.name === "__Secure-3PAPISID");
        if (fallback) cookie += `; SAPISID=${fallback.value}`;
      }
      if (!cookie.includes("SAPISID=")) throw new Error("Log in to YouTube first");
      const yt = await Innertube.create({ cookie, retrieve_player: false });
      const response = await yt.studio.upload(new Blob([await readFile(files[0])], { type: "video/mp4" }), {
        title: post.title,
        description: post.caption,
        privacy: post.visibility,
        is_draft: false,
      });
      const id = findId(response.data, ["videoId", "video_id", "encryptedVideoId"]);
      return response.success && id
        ? { url: `https://youtu.be/${id}` }
        : { uncertain: true, message: "YouTube did not confirm a video URL. Check Studio." };
    }
    let publishedUrl;
    let submitting = false;
    const responses = new Set();
    // What the page sent after Publish, minus telemetry: evidence when no post is confirmed.
    const sent = new Set();
    page.on("request", (request) => {
      const { host, pathname } = new URL(request.url());
      if (submitting && request.method() === "POST" && !/apm|\/sec\/|track|log|metric/i.test(host + pathname))
        sent.add(host + pathname);
    });
    page.on("response", (response) => {
      if (!submitting) return;
      const url = response.url();
      // RedNote and Xiaohongshu create notes through /web_api/sns/v2/note, whose response carries the note id.
      const endpoint =
        platform === "tiktok"
          ? /tiktok\.com\/.*(?:publish|\/post\/)/
          : /(?:xiaohongshu|rednote)\.com\/.*(?:publish|note\/post|\/sns\/v2\/note)(?:[/?]|$)/;
      if (response.request().method() !== "POST" || !endpoint.test(url) || !response.ok()) return;
      const task = response
        .json()
        .then((data) => {
          if (data.code !== undefined && data.code !== 0) return;
          if (data.status_code !== undefined && data.status_code !== 0) return;
          if (data.success === false) return;
          const note = typeof data.data?.id === "string" && /^[a-f\d]{24}$/.test(data.data.id) ? data.data.id : null;
          const id =
            platform === "tiktok" ? findId(data, ["video_id", "item_id"]) : (findId(data, ["note_id", "noteId"]) ?? note);
          if (id)
            publishedUrl =
              platform === "tiktok"
                ? `https://www.tiktok.com/@_/video/${id}`
                : `${explore}/${id}`;
        })
        .catch(() => {})
        .finally(() => responses.delete(task));
      responses.add(task);
    });
    const url = await destination(platform, context);
    // Notes open on the site the account published from.
    const explore = url === rednote ? "https://www.rednote.com/explore" : "https://www.xiaohongshu.com/explore";
    await page.goto(url);
    if (platform === "xiaohongshu") {
      await clickUploadTab(page, post.kind === "photo" ? "上传图文" : "上传视频");
      if (post.kind === "photo") {
        for (let i = 0; i < files.length; i++) {
          const input =
            i === 0 ? page.locator(".upload-input") : page.locator('input[type="file"][accept*="image"]');
          await input.first().setInputFiles(files[i]);
          await page.locator(".img-preview-area .pr").nth(i).waitFor({ state: "visible" });
        }
      } else await page.locator('input[type="file"]').first().setInputFiles(files);
      await page.locator("div.d-input input").first().fill(post.title);
      await page
        .locator(
          'div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor',
        )
        .first()
        .fill(post.caption);
      submitting = true;
      await page
        .locator(
          'xhs-publish-btn:not([is-publish="false"]):not([submit-disabled="true"]), .publish-page-publish-btn button.bg-red:not([disabled]):not([aria-disabled="true"]):not(.disabled)',
        )
        .first()
        .click({ timeout: 10 * 60_000 });
    } else {
      await page.locator('input[type="file"]').first().setInputFiles(files);
      await page.locator('[contenteditable="true"]').first().fill(post.caption);
      submitting = true;
      await page.getByRole("button", { name: "Post", exact: true }).click({ timeout: 10 * 60_000 });
    }
    const deadline = Date.now() + 120_000;
    while (!publishedUrl && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1000));
    await Promise.allSettled([...responses]);
    if (publishedUrl) return { url: publishedUrl };
    await page.screenshot({ path: join(profile, "last-error.png") }).catch(() => {});
    const shown = await page
      .locator('[role="dialog"]:visible, .d-modal:visible, [class*="toast"]:visible')
      .first()
      .innerText({ timeout: 1000 })
      .catch(() => "");
    return {
      uncertain: true,
      message: [
        "No confirmed post URL. Check the destination before posting again.",
        shown && `Page shows: ${shown.replace(/\s+/g, " ").slice(0, 120)}.`,
        "Screenshot: last-error.png in this destination's profile.",
        `Sent after Publish: ${[...sent].slice(-5).join(", ") || "nothing"}.`,
      ]
        .filter(Boolean)
        .join(" "),
    };
  } finally {
    await context.close();
  }
}
