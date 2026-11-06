import { platformNames, type Platform } from "./presets";

/**
 * Where a post the owner published themselves can be linked from, and the shape of its own page. The helper reads
 * stats by these links (`deletionDestination` in scripts/publisher/delete.mjs), so each one is kept in a shape it
 * takes. Grain and Bluesky are left out: the helper only knows their posts by the record it wrote.
 */
const linkable: { platform: Platform; host: RegExp; example: string; parse(url: URL): string | null }[] = [
  {
    platform: "tiktok",
    host: /(^|\.)tiktok\.com$/,
    example: "tiktok.com/@name/video/…",
    parse(url) {
      const [, handle, kind, id] = url.pathname.match(/^\/(@[\w.-]+)\/(video|photo)\/(\d+)\/?$/) ?? [];
      return id ? `https://www.tiktok.com/${handle}/${kind}/${id}` : null;
    },
  },
  {
    platform: "youtube",
    host: /^(?:(?:www|m)\.)?youtube\.com$|^youtu\.be$/,
    example: "youtube.com/shorts/…",
    parse(url) {
      if (url.hostname === "youtu.be") {
        const id = url.pathname.match(/^\/([\w-]{11})\/?$/)?.[1];
        return id ? `https://www.youtube.com/watch?v=${id}` : null;
      }
      const v = url.pathname === "/watch" ? url.searchParams.get("v") : null;
      if (v && /^[\w-]{11}$/.test(v)) return `https://www.youtube.com/watch?v=${v}`;
      const [, kind, id] = url.pathname.match(/^\/(shorts|post)\/([\w-]{5,80})\/?$/) ?? [];
      return id ? `https://www.youtube.com/${kind}/${id}` : null;
    },
  },
  {
    platform: "instagram",
    host: /(^|\.)instagram\.com$/,
    example: "instagram.com/reel/…",
    parse(url) {
      // Instagram's share links can put the account first, and say "reels" for one reel.
      const [, kind, code] = url.pathname.match(/^\/(?:[\w.]+\/)?(p|reels?)\/([\w-]{5,80})\/?$/) ?? [];
      return code ? `https://www.instagram.com/${kind === "p" ? "p" : "reel"}/${code}/` : null;
    },
  },
  {
    platform: "twitter",
    host: /^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/,
    example: "x.com/name/status/…",
    parse(url) {
      const [, name, id] = url.pathname.match(/^\/(\w+)\/status\/(\d+)(?:\/(?:video|photo)\/\d+)?\/?$/) ?? [];
      return id ? `https://x.com/${name}/status/${id}` : null;
    },
  },
  {
    platform: "xiaohongshu",
    host: /^(?:www\.)?(?:xiaohongshu|rednote)\.com$/,
    example: "xiaohongshu.com/explore/…",
    parse(url) {
      const id = url.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/)?.[1];
      // The helper finds the note in the creator center of the site it was linked from.
      return id ? `https://www.${url.hostname.replace(/^www\./, "")}/explore/${id}` : null;
    },
  },
  {
    platform: "farcaster",
    host: /^(?:www\.)?(?:farcaster\.xyz|warpcast\.com)$/,
    example: "farcaster.xyz/name/0x…",
    parse(url) {
      const path = url.pathname.match(/^\/[~\w.-]+(?:\/conversations)?\/0x[a-f\d]{8,40}\/?$/)?.[0];
      return path ? `https://farcaster.xyz${path}` : null;
    },
  },
  {
    platform: "lens",
    host: /^(?:www\.)?hey\.xyz$/,
    example: "hey.xyz/posts/…",
    parse(url) {
      const id = url.pathname.match(/^\/posts\/(\w{5,80})\/?$/)?.[1];
      return id ? `https://hey.xyz/posts/${id}` : null;
    },
  },
];
export const linkablePlatforms = linkable.map((entry) => entry.platform);

export type PublicationLink = { platform: Platform; url: string } | { platform?: Platform; error: string };
/** The platform a pasted link is from, and the link in the shape the helper reads, or why it can't be linked. */
export function publicationLink(value: string): PublicationLink {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: "Paste the post's full link, starting with https://" };
  }
  const entry = linkable.find((item) => item.host.test(url.hostname));
  if (url.protocol !== "https:" || !entry) {
    const names = linkable.map((item) => platformNames[item.platform]);
    return { error: `Paste a link to a post on ${names.slice(0, -1).join(", ")} or ${names.at(-1)}` };
  }
  const canonical = entry.parse(url);
  return canonical
    ? { platform: entry.platform, url: canonical }
    : {
        platform: entry.platform,
        error: `Open the post on ${platformNames[entry.platform]} and copy the link from its page, like ${
          entry.example
        }`,
      };
}
/** The part of a publication's link that names the post, to tell when two links lead to the same one. */
export function postKey(value: string): string {
  // Links marked as published by hand were only checked to start with https://.
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  return url.searchParams.get("v") ?? url.pathname.split("/").filter(Boolean).at(-1) ?? value;
}
