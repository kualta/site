import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { recordKey } from "../lib/atproto-content.mjs";
import { owner, publishAtproto } from "./atproto.mjs";
import { openProfile } from "./browser.mjs";
import { processMedia } from "./process.mjs";

const exec = promisify(execFile);
export const storiesRoot = join(homedir(), "Movies", "Instagram Stories");
const archivePage = "https://www.instagram.com/archive/stories/";
const pad = (n) => String(n).padStart(2, "0");

/**
 * When a story was posted, on the clock of the phone that posted it. Instagram keeps that phone's UTC offset on
 * every story, so a story posted while travelling lands on the day it was there.
 */
export function postedAt(item) {
  const offset = Number.isInteger(item.timezone_offset)
    ? item.timezone_offset
    : -new Date(item.taken_at * 1000).getTimezoneOffset() * 60;
  const local = new Date((item.taken_at + offset) * 1000).toISOString().slice(0, 19);
  const hours = Math.floor(Math.abs(offset) / 3600);
  const minutes = Math.floor((Math.abs(offset) % 3600) / 60);
  const zone = `${offset < 0 ? "-" : "+"}${pad(hours)}:${pad(minutes)}`;
  return { date: local.slice(0, 10), time: local.slice(11), zone };
}

/** The largest rendition. Instagram mixes a music sticker's song into the story video's own sound. */
export function storyMedia(item) {
  const video = item.media_type === 2;
  const renditions = (video ? item.video_versions : item.image_versions2?.candidates) ?? [];
  let largest = null;
  for (const rendition of renditions)
    if (rendition?.url && (!largest || rendition.width * rendition.height > largest.width * largest.height))
      largest = rendition;
  return largest ? { url: largest.url, ext: video ? "mp4" : "jpg" } : null;
}

/** Dates every photo app and Finder read, all set to the moment the story was posted. */
export function dateTags({ date, time, zone }, ext) {
  const stamp = `${date.replaceAll("-", ":")} ${time}`;
  if (ext === "jpg")
    return [
      `-DateTimeOriginal=${stamp}`,
      `-CreateDate=${stamp}`,
      `-ModifyDate=${stamp}`,
      `-OffsetTimeOriginal=${zone}`,
      `-OffsetTimeDigitized=${zone}`,
      `-OffsetTime=${zone}`,
    ];
  // QuickTime keeps UTC; Apple's CreationDate keeps the local time with its zone, which Photos shows.
  return [
    "-api",
    "QuickTimeUTC=1",
    ...["CreateDate", "ModifyDate", "TrackCreateDate", "TrackModifyDate", "MediaCreateDate", "MediaModifyDate"].map(
      (tag) => `-QuickTime:${tag}=${stamp}${zone}`,
    ),
    `-Keys:CreationDate=${stamp}${zone}`,
  ];
}

/** Instagram's web replies sometimes open with a for(;;); guard and wrap their data in a payload. */
function parse(text) {
  const data = JSON.parse(text.replace(/^for \(;;\);/, ""));
  return data.payload ?? data;
}
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}
async function writeIndex(file, index) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(index, null, 1));
  await rename(`${file}.tmp`, file);
}
async function readIndex(file) {
  try {
    const index = JSON.parse(await readFile(file, "utf8"));
    return { days: index.days ?? {}, stories: index.stories ?? [] };
  } catch (error) {
    if (error.code === "ENOENT") return { days: {}, stories: [] };
    throw error;
  }
}

/**
 * Saves every story in the signed-in account's Instagram archive that isn't saved yet, as
 * <root>/YYYY/MM/YYYY-MM-DD HH.MM.SS.mp4 dated to when it was posted. The archive page loads its days as it
 * scrolls, so this reads the replies the page asks for and scrolls only until every unsaved day has arrived.
 * index.json in the root lists each saved story and remembers finished days so later runs skip them.
 */
export async function archiveStories({
  stateDir,
  root = storiesRoot,
  open = openProfile,
  fetcher = fetch,
  tag = (args) => exec("exiftool", args),
  log = console.log,
} = {}) {
  const indexFile = join(root, "index.json");
  const index = await readIndex(indexFile);
  const savedIds = new Set(index.stories.map((story) => story.id));
  const days = new Map();
  const reels = new Map();
  let more = false;
  let replies = 0;
  const context = await open(join(stateDir, "instagram"), true);
  try {
    const page = context.pages()[0] || (await context.newPage());
    page.on("response", async (response) => {
      try {
        const { pathname } = new URL(response.url());
        const shells = pathname.startsWith("/api/v1/archive/reel/day_shells/");
        if (!response.ok() || !(shells || pathname.startsWith("/api/v1/feed/reels_media/"))) return;
        const data = parse(await response.text());
        if (shells) {
          for (const day of data.items ?? []) days.set(day.id, day.media_count);
          more = Boolean(data.more_available);
        } else
          for (const reel of data.reels ? Object.values(data.reels) : data.reels_media ?? [])
            if (reel?.id && Array.isArray(reel.items)) reels.set(reel.id, reel.items);
        replies++;
      } catch {
        // A reply that isn't the archive's JSON.
      }
    });
    await page.goto(archivePage, { waitUntil: "domcontentloaded", timeout: 30_000 });
    for (let i = 0; i < 60 && !days.size; i++) {
      if (new URL(page.url()).pathname.startsWith("/accounts/login")) break;
      await page.waitForTimeout(500);
    }
    if (!days.size) throw new Error("Instagram's story archive didn't load. Log in to Instagram in the crossposter.");
    const unsaved = () => [...days].filter(([id, count]) => index.days[id] !== count).map(([id]) => id);
    for (let idle = 0, seen = replies; idle < 10; ) {
      const oldest = [...days.keys()].at(-1);
      const reachedSaved = !more || index.days[oldest] === days.get(oldest);
      if (reachedSaved && unsaved().every((id) => reels.has(id))) break;
      await page.mouse.wheel(0, 4000);
      await page.waitForTimeout(1500);
      idle = replies === seen ? idle + 1 : 0;
      seen = replies;
    }
    let saved = 0;
    for (const day of unsaved()) {
      const items = reels.get(day);
      if (!items) continue;
      let complete = true;
      for (const item of items) {
        // pk outgrows JavaScript's numbers; id is the same number as text, followed by _<owner>.
        const id = String(item.id ?? "").split("_")[0];
        if (!id || savedIds.has(id)) continue;
        try {
          const media = storyMedia(item);
          if (!media) throw new Error("no media");
          const when = postedAt(item);
          const response = await fetcher(media.url, {
            headers: {
              Referer: "https://www.instagram.com/",
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            },
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw new Error(`download failed (${response.status})`);
          const dir = join(root, when.date.slice(0, 4), when.date.slice(5, 7));
          await mkdir(dir, { recursive: true });
          const name = `${when.date} ${when.time.replaceAll(":", ".")}`;
          let file = join(dir, `${name}.${media.ext}`);
          for (let n = 2; await exists(file); n++) file = join(dir, `${name} (${n}).${media.ext}`);
          const partial = join(dir, `.${id}.${media.ext}`);
          await writeFile(partial, Buffer.from(await response.arrayBuffer()));
          try {
            await tag(["-overwrite_original", "-q", ...dateTags(when, media.ext), partial]);
            const moment = new Date(item.taken_at * 1000);
            // Setting a time older than the file's creation date moves that date back too.
            await utimes(partial, moment, moment);
            await rename(partial, file);
          } finally {
            await rm(partial, { force: true });
          }
          const music = item.story_music_stickers?.[0]?.music_asset_info;
          index.stories.push({
            id,
            posted: `${when.date}T${when.time}${when.zone}`,
            file: file.slice(root.length + 1),
            ...(music?.title ? { song: music.title, artist: music.display_artist } : {}),
          });
          savedIds.add(id);
          saved++;
          index.stories.sort((a, b) => a.posted.localeCompare(b.posted));
          await writeIndex(indexFile, index);
          await page.waitForTimeout(500 + Math.random() * 1000);
        } catch (error) {
          complete = false;
          log(`Story ${id} not saved: ${error.message}`);
        }
      }
      if (complete) {
        index.days[day] = days.get(day);
        await writeIndex(indexFile, index);
      }
    }
    return { saved, total: index.stories.length };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Pinkleap shows a Bluesky post with this tag as a story. */
export const pinkleapTags = ["pinkleapStory"];
/** How long a story is up on Instagram, and so how long after posting it's still worth sending on. */
const STORY_LIFE_MS = 24 * 60 * 60_000;

/** `now` on the clock of the `zone` (as in -05:00), written the way AT Protocol dates are. */
export function clockTime(now, zone) {
  const [, sign, hours, minutes] = zone.match(/^([+-])(\d\d):(\d\d)$/) ?? [];
  if (!sign) return new Date(now).toISOString();
  const offset = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes)) * 60_000;
  return `${new Date(now + offset).toISOString().slice(0, 23)}${zone}`;
}

/**
 * Sends each saved story that's still up on Instagram, and hasn't gone yet, to Pinkleap: a post on the Bluesky account
 * with no text, the story's photo or video, and Pinkleap's story tag. On Bluesky itself it's an ordinary post. It's
 * dated when it's sent, on the clock the story was posted with, so the site files it under that day. index.json notes
 * each one's post, and a run stopped after posting finds the post by its fixed key rather than posting it twice.
 */
export async function crosspostStories({
  root = storiesRoot,
  oauth,
  process = processMedia,
  atproto = publishAtproto,
  fetcher = fetch,
  now = Date.now(),
  clock = Date.now,
  log = console.log,
} = {}) {
  const indexFile = join(root, "index.json");
  const index = await readIndex(indexFile);
  const due = index.stories
    .filter((story) => !story.pinkleap && now - Date.parse(story.posted) < STORY_LIFE_MS)
    .sort((a, b) => Date.parse(a.posted) - Date.parse(b.posted));
  if (!due.length) return { posted: 0 };
  const authorization = await oauth.agent();
  const temp = await mkdtemp(join(tmpdir(), "kualta-story-"));
  let posted = 0;
  // Bluesky's author feed shows one of the posts sharing a time and drops the rest, so each story's time follows the last.
  let sentAt = 0;
  try {
    for (const story of due) {
      const id = `story-${story.id}`;
      const rkey = recordKey(`publisher:bluesky:${id}`);
      try {
        const query = new URLSearchParams({ repo: owner, collection: "app.bsky.feed.post", rkey });
        const existing = await fetcher(`${authorization.pdsUrl.origin}/xrpc/com.atproto.repo.getRecord?${query}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!existing.ok) {
          const kind = story.file.endsWith(".jpg") ? "photo" : "video";
          const output = join(temp, `${story.id}.${kind === "photo" ? "jpg" : "mp4"}`);
          const info = await process(join(root, story.file), output, {
            kind,
            policy: "remove-all",
            maxBytes: 1_900_000,
          });
          const zone = story.posted.match(/[+-]\d\d:\d\d$/)?.[0] ?? "";
          sentAt = Math.max(clock(), sentAt + 1);
          await atproto("bluesky", authorization, [output], [info], {
            id,
            kind,
            caption: "",
            alt: "",
            tags: pinkleapTags,
            createdAt: clockTime(sentAt, zone),
          });
        }
        story.pinkleap = `https://bsky.app/profile/${owner}/post/${rkey}`;
        posted++;
        await writeIndex(indexFile, index);
      } catch (error) {
        log(`Story ${story.id} not sent to Pinkleap: ${error.message}`);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { posted };
}
