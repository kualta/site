import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Innertube } from "youtubei.js";
import { rejected } from "./protocol.mjs";

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
/**
 * Typed "#name" stays plain text on Xiaohongshu: a topic links only when picked from the editor's topic list.
 * Types each topic on a line after the text and picks its exact name; a topic the list doesn't offer is erased.
 */
export async function addTopics(page, editor, topics) {
  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element.lastElementChild ?? element);
    range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  if ((await editor.innerText()).trim()) await page.keyboard.press("Enter");
  const linked = editor.locator("a[data-topic]");
  for (const topic of topics) {
    const before = await linked.count();
    await page.keyboard.type(`#${topic}`, { delay: 120 });
    const item = page
      .locator("#creator-editor-topic-container .item")
      .filter({ has: page.getByText(`#${topic}`, { exact: true }) });
    try {
      await item.first().click({ timeout: 10_000 });
      // The link goes in once RedNote has looked the name up; typing sooner lands around it.
      await linked.nth(before).waitFor({ timeout: 15_000 });
    } catch {
      for (let i = 0; i <= [...topic].length; i++) await page.keyboard.press("Backspace");
    }
  }
  return linked.count();
}
/** xhs-publish-btn draws 暂存离开 and 发布 side by side in a closed shadow root, so its centre is the gap between them. */
export async function clickShadowButton(page, host, label) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const find = (node, test, parent = null) => {
      if (test(node)) return { node, parent };
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
        const found = find(child, test, node);
        if (found) return found;
      }
      return null;
    };
    const owner = find(root, (node) => node.nodeName === host.toUpperCase())?.node;
    const text = owner && find(owner, (node) => node.nodeType === 3 && node.nodeValue.trim() === label);
    if (!text) throw new Error(`Xiaohongshu's ${label} button is missing`);
    const { model } = await cdp.send("DOM.getBoxModel", { nodeId: text.parent.nodeId });
    const xs = model.border.filter((_, i) => i % 2 === 0);
    const ys = model.border.filter((_, i) => i % 2 === 1);
    await page.mouse.click((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2);
  } finally {
    await cdp.detach();
  }
}
/** A place name, compared without case or accents: "Bogotá, Colombia" matches "Bogota". */
const plain = (text) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
/**
 * The offered place that best matches the one asked for. Each offer is its name, then the line under it: an address,
 * or its name in another language. Best is a name that is exactly the place, then one whose second line is (波哥大 /
 * Bogota), then a name starting with it, then the shortest name containing it: "Bogotá" picks the city over a hostel
 * in Bogotá. An address that merely contains the city doesn't count, and -1 means none is that place: a nearby café
 * is worse than no place at all.
 */
export function closestPlace(offered, place, { named = false } = {}) {
  const full = plain(place);
  const name = plain(place.split(",")[0]);
  const rank = (text, under = "") => {
    const option = plain(text);
    if (option === full || option === name) return 0;
    if ([full, name].includes(plain(under))) return 0.5;
    if (option.startsWith(name)) return 1 + option.length / 1e4;
    if (option.includes(name)) return 2 + option.length / 1e4;
    return 3;
  };
  const ranks = offered.map(([text, under]) => rank(text ?? "", under ?? ""));
  const best = Math.min(...ranks, 3);
  // `named`: only a place called that (or listed under that name), not one named after it: "Bogota Bar".
  return best < (named ? 1 : 3) ? ranks.indexOf(best) : -1;
}
/** TikTok's Edit cover dialog: upload the image, then Save. The cover box shows once the video has uploaded. */
export async function setTikTokCover(page, cover) {
  await page
    .locator('[data-e2e="cover_container"]')
    .getByText("Edit cover", { exact: true })
    .click({ timeout: 10 * 60_000 });
  // TikTok only takes an image chosen through its picker: one set straight on its input never uploads.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Upload cover image" }).click(),
  ]);
  await chooser.setFiles(cover);
  // The image replaces the upload tile once TikTok has it.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[class*="ImageUpload"]')].some(
        (el) => el.querySelector("img") || getComputedStyle(el).backgroundImage !== "none",
      ),
    null,
    { timeout: 60_000 },
  );
  await page.waitForTimeout(1500);
  const save = page.getByRole("button", { name: "Save", exact: true });
  await save.click();
  await save.waitFor({ state: "hidden", timeout: 30_000 });
}
/** Xiaohongshu's cover editor: the default cover opens 设置封面, whose 上传封面 tab takes the image; 确定 keeps it. */
export async function setXiaohongshuCover(page, cover) {
  // The default cover appears once the video has uploaded.
  await page.locator(".cover-plugin-preview .cover .default").first().click({ timeout: 10 * 60_000 });
  const modal = page.locator(".d-modal").filter({ hasText: "上传封面" }).last();
  // Clicking it opens the editor, or first shows 编辑封面 over it.
  const opened = await modal
    .waitFor({ state: "visible", timeout: 4000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) await page.locator(".cover-edit-entry").first().click();
  await modal.getByText("上传封面", { exact: true }).click();
  await modal.locator('input[type="file"][accept*="image"]').setInputFiles(cover);
  await page.waitForTimeout(3000);
  await modal.getByText("确定", { exact: true }).click();
  await modal.waitFor({ state: "hidden", timeout: 30_000 });
}
/** Xiaohongshu's 添加地点: searches the place and picks the closest of its own places, or none if none is that place. */
export async function setXiaohongshuLocation(page, place) {
  await page.getByText("添加地点", { exact: true }).first().click();
  await page.waitForTimeout(1000);
  const options = page.locator(".option-name");
  // Its search finds places by name ("Bogotá, Colombia" finds nothing, "Bogotá" finds the city), and may want it
  // without accents.
  const name = place.split(",")[0].trim();
  let typed = "";
  for (const query of new Set([name, name.normalize("NFD").replace(/\p{Diacritic}/gu, "")])) {
    for (let i = 0; i < [...typed].length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type(query, { delay: 80 });
    typed = query;
    // The list opens on nearby places; the search's results come after, a few at a time: choose once it settles.
    let previous = "";
    for (let second = 0; second < 12; second++) {
      await page.waitForTimeout(1000);
      // Each offer is a name with an address or its name in another language under it: 波哥大 / Bogota.
      const offered = await options.evaluateAll((names) =>
        names.map((el) => [el.innerText, el.parentElement?.querySelector(".option-subname")?.innerText ?? ""]),
      );
      const listed = JSON.stringify(offered);
      const settled = listed === previous;
      previous = listed;
      const index = closestPlace(offered, place, { named: true });
      if (index < 0 || !settled) continue;
      await options.nth(index).click();
      return offered[index][0].trim();
    }
  }
  throw new Error(`it offered no place named ${name}`);
}
/** TikTok's Photos tab takes the whole set at once, in order, and says how many it has once they're up. */
export async function addTikTokPhotos(page, files) {
  await page.locator('input[type="file"][accept*="image"]').first().setInputFiles(files);
  await page
    .getByText(new RegExp(`^${files.length} photos? uploaded`))
    .first()
    .waitFor({ timeout: 10 * 60_000 });
}
/**
 * A caption as TikTok's editor takes it: text to type, and hashtags, which link only when picked from the editor's
 * list. Picking one types a space after it: `space` says the caption has one there (or ends), so it stays.
 */
export function tikTokCaptionParts(caption) {
  const pieces = caption.replace(/\r\n?/g, "\n").split(/(?<=^|\s)#([\p{L}\p{N}_]+)/u);
  const parts = [];
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2) {
      const next = pieces[i + 1];
      parts.push({ tag: pieces[i], space: next === "" || next.startsWith(" ") });
    } else {
      const text = i > 0 && pieces[i].startsWith(" ") ? pieces[i].slice(1) : pieces[i];
      if (text) parts.push({ text });
    }
  }
  return parts;
}
/**
 * Writes TikTok's caption over the file name it fills in on upload, picking each hashtag from its list so it links.
 * Throws, before anything is posted, if the editor doesn't read back the caption.
 */
export async function writeTikTokCaption(page, caption) {
  const editor = page.locator('[contenteditable="true"]').first();
  // The file name ("0") shows as the upload starts; typed over sooner, it can land in front of the caption.
  await editor
    .filter({ hasText: /\S/ })
    .waitFor({ timeout: 10_000 })
    .catch(() => {});
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  const linked = editor.locator('[data-testid="mentionText"]');
  const list = page.locator(".mention-list-popover");
  const parts = tikTokCaptionParts(caption);
  for (const part of parts) {
    if (part.text !== undefined) {
      await page.keyboard.type(part.text);
      continue;
    }
    const before = await linked.count();
    await page.keyboard.type(`#${part.tag}`, { delay: 120 });
    try {
      await list
        .locator(".hash-tag-topic")
        .filter({ hasText: new RegExp(`^#${part.tag}$`, "iu") })
        .first()
        .click({ timeout: 10_000 });
      await linked.nth(before).waitFor({ timeout: 5000 });
      if (!part.space) await page.keyboard.press("Backspace");
    } catch {
      // Left as typed: it shows, unlinked. Enter would pick from a list still open.
      if (await list.isVisible()) await page.keyboard.press("Escape");
      if (part.space) await page.keyboard.type(" ");
    }
  }
  const flat = (text) => text.replace(/\s+/g, "").toLowerCase();
  const shown = await editor.innerText();
  if (flat(shown) !== flat(caption))
    throw rejected(
      `TikTok's caption came out as "${shown.replace(/\s+/g, " ").trim().slice(0, 80)}", so nothing was posted.`,
    );
  return { linked: await linked.count(), tags: parts.filter((part) => part.tag !== undefined).length };
}
/**
 * Fills a post on the signed-in channel's Posts tab, whose composer takes up to 10 images, and returns its Post
 * button. Post turns on as soon as images are picked, so this first waits for their uploads to finish.
 */
export async function composeYoutubePost(page, files, caption) {
  await page.goto("https://www.youtube.com/profile");
  await page.waitForURL(/youtube\.com\/(?:channel\/UC[\w-]+|@[\w.-]+)/, { timeout: 30_000 }).catch(() => {});
  const channel = new URL(page.url()).pathname.match(/^\/(channel\/UC[\w-]+|@[\w.-]+)/)?.[1];
  if (!channel) throw new Error("Log in to YouTube first");
  await page.goto(`https://www.youtube.com/${channel}/posts`);
  const dialog = page.locator("ytd-backstage-post-dialog-renderer").first();
  await dialog.getByRole("button", { name: "Add an image", exact: true }).click();
  let started = 0;
  let finished = 0;
  const upload = (request) =>
    request.method() === "POST" && new URL(request.url()).pathname.startsWith("/channel_image_upload/");
  page.on("request", (request) => upload(request) && started++);
  page.on("requestfinished", (request) => upload(request) && finished++);
  page.on("requestfailed", (request) => upload(request) && finished++);
  await dialog.locator('input[type="file"][multiple]').first().setInputFiles(files);
  // Each image goes up in its own requests; all of them answered and nothing new for 1.5 s means they're in.
  const deadline = Date.now() + 10 * 60_000;
  for (let quiet = 0; quiet < 3; ) {
    if (Date.now() > deadline) throw new Error("YouTube didn't finish uploading the images");
    await page.waitForTimeout(500);
    quiet = started >= files.length && finished === started ? quiet + 1 : 0;
  }
  await dialog.locator("#contenteditable-root").first().fill(caption);
  return dialog.locator('button[aria-label="Post"]:not([disabled])').first();
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
/** A compact outline of a JSON reply, e.g. {success,code,data:{id}}, for evidence without the values. */
function outline(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return typeof value;
  const keys = Object.entries(value)
    .slice(0, 8)
    .map(([key, item]) => (item && typeof item === "object" && !Array.isArray(item) ? `${key}:${outline(item)}` : key));
  return `{${keys.join(",")}}`;
}
/** Where a post published in the browser can be found: TikTok keeps photo posts apart from videos. */
export function publicationUrl(platform, kind, id, explore) {
  if (platform === "tiktok") return `https://www.tiktok.com/@_/${kind === "photo" ? "photo" : "video"}/${id}`;
  if (platform === "youtube") return `https://www.youtube.com/post/${id}`;
  return `${explore}/${id}`;
}
// RedNote and Xiaohongshu create notes with this request; its reply carries the note id.
const createNote = /\/web_api\/sns\/v\d+\/note(?:[/?]|$)/;
/** The request each browser flow's Publish sends, and the fields of its reply that carry the new post's id. */
const publishRequests = {
  tiktok: { endpoint: /tiktok\.com\/.*(?:publish|\/post\/)/, ids: ["video_id", "item_id"] },
  youtube: { endpoint: /youtube\.com\/youtubei\/v1\/backstage\/create_post/, ids: ["postId"] },
  xiaohongshu: {
    endpoint: new RegExp(`(?:xiaohongshu|rednote)\\.com\\/.*(?:publish|note\\/post)(?:[/?]|$)|${createNote.source}`),
    ids: ["note_id", "noteId"],
  },
};
function findId(value, names) {
  if (!value || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (names.includes(key) && typeof item === "string" && /^[\w-]{8,64}$/.test(item)) return item;
    const nested = findId(item, names);
    if (nested) return nested;
  }
  return null;
}
export async function publishBrowser(platform, profile, files, post, infos = [], signal, { cover } = {}) {
  const context = await openProfile(profile);
  // Closing the browser fails whatever the flow is waiting on.
  signal?.addEventListener("abort", () => void context.close().catch(() => {}), { once: true });
  try {
    if (signal?.aborted) throw new Error("Stopped");
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(60_000);
    // Photos go to the channel's Posts tab in the browser below; a video goes up through YouTube's API.
    if (platform === "youtube" && post.kind === "video") {
      const cookies = await context.cookies("https://www.youtube.com");
      let cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      if (!cookies.some((c) => c.name === "SAPISID")) {
        const fallback = cookies.find((c) => c.name === "__Secure-3PAPISID");
        if (fallback) cookie += `; SAPISID=${fallback.value}`;
      }
      if (!cookie.includes("SAPISID=")) throw new Error("Log in to YouTube first");
      const yt = await Innertube.create({
        cookie,
        retrieve_player: false,
        fetch: (input, init) => fetch(input, { ...init, signal }),
      });
      const response = await yt.studio.upload(new Blob([await readFile(files[0])], { type: "video/mp4" }), {
        title: post.title,
        description: post.caption,
        privacy: post.visibility,
        is_draft: false,
      });
      const id = findId(response.data, ["videoId", "video_id", "encryptedVideoId"]);
      // YouTube makes a vertical or square video up to 3 minutes a Short.
      const short = infos[0] && infos[0].height >= infos[0].width && infos[0].duration <= 180;
      if (!response.success || !id) return { uncertain: true, message: "YouTube did not confirm a video URL. Check Studio." };
      let message = "";
      // The video is already up: a cover YouTube refuses (unverified accounts can't set one) doesn't undo it.
      if (cover)
        await yt.studio
          .updateVideoMetadata(id, { thumbnail: new Uint8Array(await readFile(cover)) })
          .catch((error) => {
            message = `Posted with YouTube's own thumbnail: setting the cover failed (${error.message.slice(0, 120)}).`;
          });
      return { url: short ? `https://www.youtube.com/shorts/${id}` : `https://youtu.be/${id}`, message };
    }
    let publishedUrl;
    let submitting = false;
    // What a best-effort step couldn't do, said with the result.
    const notes = [];
    let reply;
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
      const { endpoint, ids } = publishRequests[platform];
      if (response.request().method() !== "POST" || !endpoint.test(response.url())) return;
      if (!response.ok()) {
        reply = `${response.status()}`;
        return;
      }
      const task = response
        .json()
        .then((data) => {
          reply = `${response.status()} ${outline(data)}${typeof data.msg === "string" && data.msg ? ` "${data.msg.slice(0, 60)}"` : ""}`;
          if (data.code !== undefined && data.code !== 0) return;
          if (data.status_code !== undefined && data.status_code !== 0) return;
          if (data.success === false) return;
          let id = findId(data, ids);
          // Xiaohongshu may answer with only the note's 24-character id under data.id.
          if (!id && platform === "xiaohongshu" && /^[a-f\d]{24}$/.test(data.data?.id ?? "")) id = data.data.id;
          if (id) publishedUrl = publicationUrl(platform, post.kind, id, explore);
        })
        .catch(() => {})
        .finally(() => responses.delete(task));
      responses.add(task);
    });
    const url = await destination(platform, context);
    // Notes open on the site the account published from.
    const explore = url === rednote ? "https://www.rednote.com/explore" : "https://www.xiaohongshu.com/explore";
    // TikTok takes photos on its own tab; YouTube's posts open from the channel.
    if (platform === "tiktok" && post.kind === "photo") await page.goto(`${url}?tab=photo`);
    else if (platform !== "youtube") await page.goto(url);
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
      const editor = page
        .locator('div[role="textbox"][contenteditable="true"], div.tiptap[contenteditable="true"], div.ql-editor')
        .first();
      await editor.fill(post.caption);
      if (post.tags?.length) {
        const linked = await addTopics(page, editor, post.tags);
        if (linked < post.tags.length) console.error(`Xiaohongshu linked ${linked} of ${post.tags.length} topics`);
      }
      if (cover && post.kind === "video")
        await setXiaohongshuCover(page, cover).catch((error) => {
          notes.push(`Kept Xiaohongshu's own cover: ${error.message.split("\n")[0].slice(0, 100)}.`);
          return page.keyboard.press("Escape");
        });
      if (post.location)
        await setXiaohongshuLocation(page, post.location)
          .then((chosen) => console.error(`Xiaohongshu tagged ${chosen}`))
          .catch((error) => {
            notes.push(`Posted without a location: ${error.message.split("\n")[0].slice(0, 100)}.`);
            return page.keyboard.press("Escape");
          });
      // Publish turns on once uploads finish, which can take a while for video.
      const publish = page
        .locator(
          'xhs-publish-btn:not([is-publish="false"]):not([submit-disabled="true"]), .publish-page-publish-btn button.bg-red:not([disabled]):not([aria-disabled="true"]):not(.disabled)',
        )
        .first();
      await publish.waitFor({ timeout: 10 * 60_000 });
      submitting = true;
      if (await publish.evaluate((element) => element.localName === "xhs-publish-btn")) {
        // 发布 ignores clicks while photos are still uploading: click until the note request goes out, never after.
        let requested = false;
        page.on("request", (request) => {
          if (request.method() === "POST" && createNote.test(request.url())) requested = true;
        });
        for (let attempt = 0; attempt < 12 && !requested; attempt++) {
          await clickShadowButton(page, "xhs-publish-btn", "发布");
          for (let tick = 0; tick < 20 && !requested; tick++) await page.waitForTimeout(500);
        }
      } else await publish.click();
    } else if (platform === "youtube") {
      const postButton = await composeYoutubePost(page, files, post.caption);
      submitting = true;
      await postButton.click();
    } else {
      if (platform === "tiktok" && post.kind === "photo") await addTikTokPhotos(page, files);
      else await page.locator('input[type="file"]').first().setInputFiles(files);
      const { linked, tags } = await writeTikTokCaption(page, post.caption);
      if (linked < tags) notes.push(`TikTok linked ${linked} of ${tags} hashtags.`);
      if (cover && platform === "tiktok")
        await setTikTokCover(page, cover).catch(async (error) => {
          notes.push(`Kept TikTok's own cover: ${error.message.split("\n")[0].slice(0, 100)}.`);
          await page
            .getByRole("button", { name: "Cancel", exact: true })
            .click({ timeout: 3000 })
            .catch(() => page.keyboard.press("Escape"));
        });
      submitting = true;
      await page.getByRole("button", { name: "Post", exact: true }).click({ timeout: 10 * 60_000 });
    }
    const deadline = Date.now() + 120_000;
    // TikTok asks "Continue to post?" while its content check is still running: Post now goes ahead.
    const postNow = page.getByRole("button", { name: "Post now", exact: true });
    while (!publishedUrl && Date.now() < deadline) {
      if (platform === "tiktok" && (await postNow.isVisible().catch(() => false)))
        await postNow.click({ timeout: 5000 }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await Promise.allSettled([...responses]);
    if (publishedUrl) return { url: publishedUrl, message: notes.join(" ") };
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
        ...notes,
        shown && `Page shows: ${shown.replace(/\s+/g, " ").slice(0, 120)}.`,
        reply && `Publish reply: ${reply}.`,
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
