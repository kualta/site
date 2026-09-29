import { join } from "node:path";
import { recordKey } from "../lib/atproto-content.mjs";
import { openProfile } from "./browser.mjs";
const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";

export function deletionDestination(platform, value, post) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("Invalid publication URL");
  if (["grain", "bluesky"].includes(platform)) {
    const key = recordKey(`publisher:${platform}:${post.id}`);
    const expected =
      platform === "grain"
        ? `https://grain.social/profile/${owner}/gallery/${key}`
        : `https://bsky.app/profile/${owner}/post/${key}`;
    if (url.href !== expected) throw new Error("Publication URL does not match this post");
    return { id: key, url: expected };
  }
  const hosts = {
    twitter: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    instagram: ["www.instagram.com", "instagram.com"],
    youtube: ["youtu.be", "www.youtube.com", "youtube.com"],
    tiktok: ["www.tiktok.com", "tiktok.com"],
    xiaohongshu: ["www.xiaohongshu.com", "xiaohongshu.com"],
  };
  if (!hosts[platform]?.includes(url.hostname)) throw new Error("Unexpected publication host");
  let id;
  if (platform === "twitter") id = url.pathname.match(/^\/[\w]+\/status\/(\d+)\/?$/)?.[1];
  if (platform === "instagram") id = url.pathname.match(/^\/(?:p|reel)\/([\w-]+)\/?$/)?.[1];
  if (platform === "tiktok") id = url.pathname.match(/^\/@[\w.-]+\/video\/(\d+)\/?$/)?.[1];
  if (platform === "xiaohongshu") id = url.pathname.match(/^\/explore\/([a-f\d]+)\/?$/)?.[1];
  if (platform === "youtube")
    id =
      url.hostname === "youtu.be"
        ? url.pathname.slice(1)
        : url.pathname === "/watch"
          ? url.searchParams.get("v")
          : null;
  if (!id || !/^[\w-]{5,80}$/.test(id)) throw new Error("Cannot identify the published post");
  return {
    id,
    url: platform === "youtube" ? `https://studio.youtube.com/video/${id}/edit` : url.origin + url.pathname,
  };
}

export function deletionResponse(platform, responseUrl, method, body, requestBody, id) {
  if (method !== "POST" && method !== "DELETE") return false;
  const url = new URL(responseUrl);
  const host = url.hostname;
  const path = url.pathname;
  const hasId = `${url.search} ${requestBody || ""}`.includes(id);
  if (platform === "twitter")
    return (
      ["x.com", "twitter.com"].includes(host) &&
      /\/DeleteTweet$/.test(path) &&
      hasId &&
      !!body?.data?.delete_tweet &&
      !body.errors?.length
    );
  if (platform === "instagram")
    return (
      ["www.instagram.com", "instagram.com"].includes(host) &&
      /\/(?:web\/create|media)\/\d+\/delete\/$/.test(path) &&
      body?.status === "ok"
    );
  if (platform === "youtube")
    return (
      host === "studio.youtube.com" && /\/delete_video$/.test(path) && hasId && body?.status === "STATUS_SUCCEEDED"
    );
  if (platform === "tiktok")
    return (
      /(^|\.)tiktok\.com$/.test(host) && /\/(?:item|aweme)\/delete\/?$/.test(path) && hasId && body?.status_code === 0
    );
  if (platform === "xiaohongshu")
    return (
      /(^|\.)xiaohongshu\.com$/.test(host) &&
      /\/note\/delete\/?$/.test(path) &&
      hasId &&
      body?.code === 0 &&
      body?.success !== false
    );
  return false;
}

export async function deletePublication(deletion, { oauth, stateDir, open = openProfile }) {
  const { target, post } = deletion;
  let submitted = false;
  let context;
  let confirmed = false;
  const responses = new Set();
  try {
    if (target.state !== "succeeded") throw new Error("Only confirmed publications can be deleted");
    const destination = deletionDestination(target.platform, target.url, post);
    if (["grain", "bluesky"].includes(target.platform)) {
      const { agent } = await oauth.agent();
      if (agent.did !== owner) throw new Error("Use kualta’s AT Protocol account");
      if (target.platform === "bluesky") {
        submitted = true;
        await agent.com.atproto.repo.deleteRecord({
          repo: owner,
          collection: "app.bsky.feed.post",
          rkey: destination.id,
        });
      } else {
        const writes = [
          {
            $type: "com.atproto.repo.applyWrites#delete",
            collection: "social.grain.gallery",
            rkey: destination.id,
          },
        ];
        for (let index = 0; index < post.media.length; index++) {
          const rkey = recordKey(`publisher:grain:${post.id}:${index}`);
          for (const collection of ["social.grain.gallery.item", "social.grain.photo"])
            writes.push({ $type: "com.atproto.repo.applyWrites#delete", collection, rkey });
        }
        submitted = true;
        await agent.com.atproto.repo.applyWrites({ repo: owner, writes });
      }
      return { state: "deleted", message: "Deleted from the platform" };
    }
    context = await open(join(stateDir, target.platform));
    const page = context.pages()[0] || (await context.newPage());
    page.setDefaultTimeout(15_000);
    await page.goto(destination.url);
    page.on("response", (response) => {
      if (!submitted || !response.ok()) return;
      const task = response
        .json()
        .then((body) => {
          if (
            deletionResponse(
              target.platform,
              response.url(),
              response.request().method(),
              body,
              response.request().postData(),
              destination.id,
            )
          )
            confirmed = true;
        })
        .catch(() => {})
        .finally(() => responses.delete(task));
      responses.add(task);
    });
    // Use only the menu on the exact publication, never a feed-wide menu.
    if (target.platform === "twitter") {
      const article = page
        .locator('article[data-testid="tweet"]')
        .filter({ has: page.locator(`a[href$="/status/${destination.id}"]`) });
      await article.getByTestId("caret").click();
      submitted = true;
      await page.getByRole("menuitem", { name: /^Delete$/ }).click();
    } else if (target.platform === "instagram") {
      await page.getByRole("button", { name: /^More options$/ }).click();
      submitted = true;
      await page
        .getByRole("dialog")
        .getByRole("button", { name: /^Delete$/ })
        .click();
    } else if (target.platform === "youtube") {
      await page.getByRole("button", { name: /^Options$/ }).click();
      submitted = true;
      await page.getByText("Delete forever", { exact: true }).click();
      await page.getByRole("checkbox").check();
    } else if (target.platform === "tiktok") {
      await page.getByRole("button", { name: /^(More|More options|More actions)$/ }).click();
      submitted = true;
      await page.getByText("Delete", { exact: true }).click();
    } else {
      await page.getByRole("button", { name: /^(更多|More)$/ }).click();
      submitted = true;
      await page.getByText("删除", { exact: true }).click();
    }
    const dialog = page.getByRole("dialog");
    const confirmation = dialog.getByRole("button", {
      name:
        target.platform === "youtube"
          ? /^Delete forever$/
          : target.platform === "xiaohongshu"
            ? /^(删除|确认删除)$/
            : /^Delete$/,
    });
    await confirmation.waitFor({ state: "visible" });
    const receipt = page.waitForResponse(
      async (response) => {
        if (!submitted || !response.ok()) return false;
        try {
          return deletionResponse(
            target.platform,
            response.url(),
            response.request().method(),
            await response.json(),
            response.request().postData(),
            destination.id,
          );
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );
    receipt.catch(() => {});
    submitted = true;
    await confirmation.click();
    await receipt;
    return { state: "deleted", message: "Platform confirmed deletion" };
  } catch {
    await Promise.allSettled([...responses]);
    if (confirmed) return { state: "deleted", message: "Platform confirmed deletion" };
    return {
      state: submitted ? "uncertain" : "failed",
      message: submitted
        ? "Deletion was not confirmed. Check the post on the platform before retrying."
        : "Could not open the post’s delete controls. Check your account and post URL, then retry.",
    };
  } finally {
    await context?.close().catch(() => {});
  }
}
