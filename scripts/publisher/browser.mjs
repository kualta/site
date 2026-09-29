import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { Innertube } from "youtubei.js";

export const destinations = {
  twitter: "https://x.com/home",
  instagram: "https://www.instagram.com/",
  youtube: "https://www.youtube.com/",
  tiktok: "https://www.tiktok.com/tiktokstudio/upload",
  xiaohongshu: "https://creator.xiaohongshu.com/publish/publish",
};
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
    page.on("response", (response) => {
      if (!submitting) return;
      const url = response.url();
      const endpoint =
        platform === "tiktok"
          ? /tiktok\.com\/.*(?:publish|\/post\/)/
          : /xiaohongshu\.com\/.*(?:publish|note\/post)(?:[/?]|$)/;
      if (response.request().method() !== "POST" || !endpoint.test(url) || !response.ok()) return;
      const task = response
        .json()
        .then((data) => {
          if (data.code !== undefined && data.code !== 0) return;
          if (data.status_code !== undefined && data.status_code !== 0) return;
          const id = findId(data, platform === "tiktok" ? ["video_id", "item_id"] : ["note_id", "noteId"]);
          if (id)
            publishedUrl =
              platform === "tiktok"
                ? `https://www.tiktok.com/@_/video/${id}`
                : `https://www.xiaohongshu.com/explore/${id}`;
        })
        .catch(() => {})
        .finally(() => responses.delete(task));
      responses.add(task);
    });
    await page.goto(destinations[platform]);
    if (platform === "xiaohongshu") {
      await page
        .getByText(post.kind === "photo" ? "上传图文" : "上传视频", { exact: true })
        .first()
        .click();
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
    return publishedUrl
      ? { url: publishedUrl }
      : { uncertain: true, message: "No confirmed post URL. Check the destination before posting again." };
  } finally {
    await context.close();
  }
}
