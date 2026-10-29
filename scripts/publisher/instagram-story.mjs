import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Instagram's web app can't post stories, so they go through the Instagram API with Instagram Login,
// using a Business account's token generated in the Meta app dashboard.
const graph = "https://graph.instagram.com/v26.0";
const accountFile = (stateDir) => join(stateDir, "instagram-story.json");
export const connectHelp =
  "Generate a token for your Business account in your Meta app, copy it, then run pbpaste | bun run publisher instagram-token on your laptop.";

async function call(url, token, { method = "GET", params, fetcher = fetch } = {}) {
  const response = await fetcher(url, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: params ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error)
    throw new Error(`Instagram: ${data.error?.message || `request failed (${response.status})`}`);
  return data;
}
async function write(stateDir, account) {
  await writeFile(accountFile(stateDir), JSON.stringify(account), { mode: 0o600 });
  return account;
}
export async function readAccount(stateDir) {
  try {
    return JSON.parse(await readFile(accountFile(stateDir), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export const forgetAccount = (stateDir) => rm(accountFile(stateDir), { force: true });

/** Checks a dashboard token and keeps it. Instagram lets only Business accounts post stories through the API. */
export async function saveAccount(stateDir, token, { fetcher = fetch, now = Date.now() } = {}) {
  const me = await call(`${graph}/me?fields=user_id,username,account_type`, token, { fetcher });
  if (!/^business$/i.test(me.account_type || ""))
    throw new Error("Instagram posts stories through its API only for Business accounts. Switch to Business first.");
  return write(stateDir, { token, userId: String(me.user_id), username: me.username, refreshedAt: now });
}
/** Tokens expire 60 days after their last refresh; refreshing weekly keeps them alive while the laptop runs. */
export async function refreshAccount(stateDir, { fetcher = fetch, now = Date.now() } = {}) {
  const account = await readAccount(stateDir);
  if (!account || now - account.refreshedAt < 7 * 86_400_000) return account;
  const url = `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(account.token)}`;
  const { access_token: token } = await call(url, account.token, { fetcher });
  return write(stateDir, { ...account, token, refreshedAt: now });
}

/** Instagram fetches story media from a URL, so the site holds each file under an unguessable name meanwhile. */
export function parkOnSite({ origin, token }, fetcher = fetch) {
  const headers = { Authorization: `Bearer ${token}` };
  return async (file, type) => {
    const response = await fetcher(`${origin}/api/publisher/helper/public-media`, {
      method: "POST",
      headers: { ...headers, "Content-Type": type },
      body: await readFile(file),
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) throw new Error(`Could not hand the story media to Instagram (${response.status})`);
    const { id, url } = await response.json();
    return {
      url,
      remove: () => fetcher(`${origin}/api/publisher/helper/public-media/${id}`, { method: "DELETE", headers }),
    };
  };
}

/** Posts the video, or each photo in order, as a story. */
export async function publishStory(
  files,
  infos,
  { stateDir, park, fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
) {
  const account = await refreshAccount(stateDir, { fetcher });
  if (!account) throw new Error(connectHelp);
  const { token, userId } = account;
  const ids = [];
  for (let i = 0; i < files.length; i++) {
    const parked = await park(files[i], infos[i].contentType);
    try {
      const media = infos[i].kind === "video" ? { video_url: parked.url } : { image_url: parked.url };
      const container = await call(`${graph}/${userId}/media`, token, {
        method: "POST",
        params: { media_type: "STORIES", ...media },
        fetcher,
      });
      for (let attempt = 0; ; attempt++) {
        const { status_code: status, status: detail } = await call(
          `${graph}/${container.id}?fields=status_code,status`,
          token,
          { fetcher },
        );
        if (status === "FINISHED") break;
        if (status !== "IN_PROGRESS" || attempt >= 60)
          throw new Error(`Instagram could not process the story: ${detail || status || "timed out"}`);
        await wait(5_000);
      }
      const published = await call(`${graph}/${userId}/media_publish`, token, {
        method: "POST",
        params: { creation_id: container.id },
        fetcher,
      });
      ids.push(published.id);
    } finally {
      await parked.remove().catch(() => {});
    }
  }
  const { permalink } = await call(`${graph}/${ids[0]}?fields=permalink`, token, { fetcher }).catch(() => ({}));
  return {
    url: /^https:\/\/(www\.)?instagram\.com\//.test(permalink || "")
      ? permalink
      : `https://www.instagram.com/stories/${account.username}/`,
  };
}
