import { type ArchiveBucket, isClipName, isProjectName, LEDGER, ledgerThumbKey } from "./archive";
import type { FootageLink } from "./ledger";
import {
  type LaneAsks,
  MAC_LANES,
  type MacLaneName,
  MAX_MAC_REPORT,
  type Paused,
  readLaneAsks,
  readMacReport,
} from "./mac";
import { type MediaBucket, validId } from "./server";

/*
 * The Footage tab shows the footage ledger the grade app keeps in the archive (every clip, whether it's graded and
 * where its copies are), with each clip's small picture.
 *
 * The footage archive's uploads run only while the composer's Footage tab is open. The tab says it's open by keeping a
 * marker fresh; the laptop asks for it every few seconds and, while it's there, sends back what's up and how the upload
 * in flight is going. Both live in the media bucket (R2 Standard, which has a free allowance, unlike the archive's
 * Infrequent Access), not D1, whose daily read cap the helper's polling has nearly reached before. Its expiry rule
 * doesn't matter: both are rewritten while they're in use.
 */
const WATCHING = "footage/watching";
const STATUS = "footage/status.json";
/** How the grade app's offload on the Mac stands (mac.ts), sent when it changes. */
const MAC = "footage/mac.json";
/**
 * Everything paused from the Footage tab, and since when: the grade app's offload, transcripts and exports, and the
 * helper's uploads to YouTube. Both laptops hear it in the answers they already get, so it holds from a phone and through
 * their restarts. Like the rest here it's under the bucket's 31-day expiry: a pause left that long lapses.
 */
const PAUSED = "footage/paused.json";
/**
 * The owner's last Start or Pause of each of the offload's switches, from the tab, and when it was asked. The grade app
 * hears them in the answers it already gets and does each once, by when it was asked; its report says which it has.
 */
const LANES = "footage/lanes.json";

export async function readPaused(media: MediaBucket): Promise<Paused | null> {
  const object = await media.get(PAUSED);
  if (!object) return null;
  const since = Number((JSON.parse(await new Response(object.body).text()) as Partial<Paused>).since);
  return Number.isFinite(since) ? { since } : null;
}
async function readLanes(media: MediaBucket): Promise<LaneAsks> {
  const object = await media.get(LANES);
  return object ? readLaneAsks(JSON.parse(await new Response(object.body).text())) : {};
}
/**
 * How long the tab counts as open after it last said so. It says so every 30 seconds, but a background tab's timers
 * can slow to once a minute; closing the tab deletes the marker at once.
 */
export const WATCH_TTL = 150_000;
/** The laptop lists at most a few hundred clips, well under this. */
export const MAX_STATUS = 256 * 1024;

export async function isWatched(media: MediaBucket, now = Date.now()) {
  const marker = await media.get(WATCHING);
  if (!marker) return false;
  return Number(await new Response(marker.body).text()) > now;
}

/** What the laptop last sent to `key`, as JSON text, and how long ago that was. */
async function readObject(media: MediaBucket, key: string, now: number) {
  const object = await media.get(key);
  if (!object) return { text: "null", age: null };
  const text = await new Response(object.body).text();
  return { text, age: object.uploaded ? Math.max(0, now - object.uploaded.getTime()) : null };
}
const readStatus = (media: MediaBucket, now: number) => readObject(media, STATUS, now);
/** What the tab hears. The status went in checked, so it goes out as it is, without parsing it again. */
function tabReply(
  watching: boolean,
  { text, age }: Awaited<ReturnType<typeof readObject>>,
  paused: Paused | null,
): Response {
  return new Response(`{"watching":${watching},"age":${age},"paused":${JSON.stringify(paused)},"status":${text}}`, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
  });
}
/** The JSON object the laptop sent, as sent and parsed, or why it can't be taken: too big, or not an object. */
async function sentObject(
  request: Request,
  most: number,
  what: string,
): Promise<{ text: string; sent: object } | { error: string; status: number }> {
  const tooBig = { error: `The ${what} is too big`, status: 413 };
  if (Number(request.headers.get("Content-Length")) > most) return tooBig;
  const text = await request.text();
  if (text.length > most) return tooBig;
  let sent: unknown = null;
  try {
    sent = JSON.parse(text);
  } catch {}
  if (sent && typeof sent === "object" && !Array.isArray(sent)) return { text, sent };
  return { error: `Send the ${what} as an object`, status: 400 };
}

/**
 * Which footage each Pipeline piece is (a film, or a shoot day before there's a film), by the piece's id: one small
 * document in the archive, so pieces gained it without a new D1 column. Only the owner writes it, a piece at a time.
 */
const LINKS = "pipeline/footage-links.json";
const isDay = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

async function readLinks(archive: Pick<ArchiveBucket, "get">): Promise<Record<string, FootageLink>> {
  const object = await archive.get(LINKS);
  return object ? ((await new Response(object.body).json()) as Record<string, FootageLink>) : {};
}

/**
 * The Footage tab's routes, with the caller already checked: `footage` (what's up with the uploads), `footage/watch`
 * (POST keeps the tab counted as open and answers as `footage` does, DELETE says it closed), `footage/ledger` and
 * `footage/thumbs/<clip>.jpg` (the ledger and its pictures, from the archive), `footage/links` (each Pipeline piece's
 * footage; PUT `footage/links/<piece>` sets one), and `helper/footage` (the laptop asks whether the tab is open, and
 * with a POST sends its status; `helper/footage/watch` POST counts the tab as open while an offload the grade app runs
 * goes), `helper/footage/mac` (POST: how the grade app's offload stands, which `footage/mac` reads),
 * `footage/pause` (POST pauses everything, DELETE goes on; the tab's and the laptops' answers say `paused`), and
 * `footage/lanes` (POST `{ lane, want }`: Start or Pause a switch; `footage/mac` says them, and the grade app hears them
 * from `helper/footage/lanes`, which it asks instead of `helper/footage`, and in its report's answer). Anything else is
 * null.
 */
export async function footageResponse(
  path: string,
  request: Request,
  { media, archive = null }: { media: MediaBucket; archive?: Pick<ArchiveBucket, "get" | "put"> | null },
  now = Date.now(),
): Promise<Response | null> {
  const headers = { "Cache-Control": "no-store" };
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  if (path === "footage/links" && request.method === "GET")
    return json({ links: archive ? await readLinks(archive) : {} });
  const piece = path.match(/^footage\/links\/(.+)$/)?.[1];
  if (piece !== undefined && request.method === "PUT") {
    if (!archive) return json({ error: "The archive bucket isn't configured" }, 503);
    if (!validId(piece)) return json({ error: "Invalid piece" }, 400);
    const { project = null, day = null } = (await request.json().catch(() => ({}))) as FootageLink;
    if ((project !== null && !isProjectName(project)) || (day !== null && !isDay(day)) || (project && day))
      return json({ error: "Name a film or a shoot day" }, 400);
    const links = await readLinks(archive);
    if (project) links[piece] = { project };
    else if (day) links[piece] = { day };
    else delete links[piece];
    await archive.put(LINKS, JSON.stringify(links), {
      httpMetadata: { contentType: "application/json" },
      storageClass: "Standard",
    });
    return json({ links });
  }
  // Both streamed as they're stored: the ledger runs to hundreds of kilobytes, and the Worker has 10 ms to spend.
  if (path === "footage/ledger" && request.method === "GET") {
    const object = archive ? await archive.get(LEDGER) : null;
    if (!object) return json({ error: "No ledger yet" }, 404);
    return new Response(object.body, { headers: { ...headers, "Content-Type": "application/json" } });
  }
  const thumb = path.match(/^footage\/thumbs\/(.+)\.jpg$/)?.[1];
  if (thumb !== undefined && request.method === "GET") {
    const object = archive && isClipName(thumb) ? await archive.get(ledgerThumbKey(thumb)) : null;
    if (!object) return json({ error: "No picture" }, 404);
    return new Response(object.body, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" },
    });
  }
  if (path === "footage" && request.method === "GET") {
    const [watching, status, paused] = await Promise.all([
      isWatched(media, now),
      readStatus(media, now),
      readPaused(media),
    ]);
    return tabReply(watching, status, paused);
  }
  // The tab keeps the marker fresh while it's open, and hears how the uploads are going: a hidden one asks nothing else.
  // The grade app keeps it fresh while an offload the owner started goes.
  if ((path === "footage/watch" || path === "helper/footage/watch") && request.method === "POST") {
    await media.put(WATCHING, String(now + WATCH_TTL), { httpMetadata: { contentType: "text/plain" } });
    if (path === "helper/footage/watch") return json({ watching: true });
    const [status, paused] = await Promise.all([readStatus(media, now), readPaused(media)]);
    return tabReply(true, status, paused);
  }
  if (path === "footage/watch" && request.method === "DELETE") {
    await media.delete(WATCHING);
    return json({ watching: false });
  }
  // Pausing everything, and going on: only the owner, from the tab; the laptops hear it in the answers below.
  if (path === "footage/pause" && request.method === "GET") return json({ paused: await readPaused(media) });
  if (path === "footage/pause" && request.method === "POST") {
    // Paused again, it's still paused since it first was.
    const paused = (await readPaused(media)) ?? { since: now };
    await media.put(PAUSED, JSON.stringify(paused), { httpMetadata: { contentType: "application/json" } });
    return json({ paused });
  }
  if (path === "footage/pause" && request.method === "DELETE") {
    await media.delete(PAUSED);
    return json({ paused: null });
  }
  if (path === "helper/footage" && request.method === "GET") {
    const [watching, paused] = await Promise.all([isWatched(media, now), readPaused(media)]);
    return json({ watching, paused });
  }
  if (path === "helper/footage" && request.method === "POST") {
    const status = await sentObject(request, MAX_STATUS, "footage status");
    if ("error" in status) return json({ error: status.error }, status.status);
    const [watching, paused] = await Promise.all([
      isWatched(media, now),
      readPaused(media),
      media.put(STATUS, status.text, { httpMetadata: { contentType: "application/json" } }),
    ]);
    return json({ watching, paused });
  }
  // How the offload on the Mac stands: kept as checked, and read back with how long ago it came.
  if (path === "helper/footage/mac" && request.method === "POST") {
    const sent = await sentObject(request, MAX_MAC_REPORT, "offload report");
    if ("error" in sent) return json({ error: sent.error }, sent.status);
    const report = readMacReport(sent.sent);
    if (!report) return json({ error: "The offload report isn't one the Footage tab can read" }, 400);
    const [paused, lanes] = await Promise.all([
      readPaused(media),
      readLanes(media),
      media.put(MAC, JSON.stringify(report), { httpMetadata: { contentType: "application/json" } }),
    ]);
    return json({ ok: true, paused, lanes });
  }
  // What the grade app asks between reports: whether everything's paused, and each switch's Start or Pause.
  if (path === "helper/footage/lanes" && request.method === "GET") {
    const [paused, lanes] = await Promise.all([readPaused(media), readLanes(media)]);
    return json({ paused, lanes });
  }
  if (path === "footage/mac" && request.method === "GET") {
    const [{ text, age }, lanes] = await Promise.all([readObject(media, MAC, now), readLanes(media)]);
    return new Response(`{"age":${age},"report":${text},"lanes":${JSON.stringify(lanes)}}`, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  // Start or Pause a switch: only the owner, from the tab. Each ask is later than the one it replaces.
  if (path === "footage/lanes" && request.method === "POST") {
    const { lane, want } = (await request.json().catch(() => ({}))) as { lane?: MacLaneName; want?: string };
    if (!MAC_LANES.includes(lane as MacLaneName) || (want !== "start" && want !== "pause"))
      return json({ error: "Say which switch, and start or pause" }, 400);
    const lanes = await readLanes(media);
    const name = lane as MacLaneName;
    lanes[name] = { want, at: Math.max(now, (lanes[name]?.at ?? 0) + 1) };
    await media.put(LANES, JSON.stringify(lanes), { httpMetadata: { contentType: "application/json" } });
    return json({ lanes });
  }
  return null;
}
