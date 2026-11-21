import { type ArchiveBucket, isClipName, isProjectName, LEDGER, ledgerThumbKey } from "./archive";
import type { FootageLink } from "./ledger";
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

/** The status as the laptop last sent it, and how long ago that was. */
async function readStatus(media: MediaBucket, now: number) {
  const object = await media.get(STATUS);
  if (!object) return { text: "null", age: null };
  const text = await new Response(object.body).text();
  return { text, age: object.uploaded ? Math.max(0, now - object.uploaded.getTime()) : null };
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
 * (POST keeps the tab counted as open, DELETE says it closed), `footage/ledger` and `footage/thumbs/<clip>.jpg` (the
 * ledger and its pictures, from the archive), `footage/links` (each Pipeline piece's footage; PUT
 * `footage/links/<piece>` sets one), and `helper/footage` (the laptop asks whether the tab is open, and with a POST
 * sends its status; `helper/footage/watch` POST counts the tab as open while an offload the grade app runs goes).
 * Anything else is null.
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
    const [watching, { text, age }] = await Promise.all([isWatched(media, now), readStatus(media, now)]);
    // The status went in checked, so it goes out as it is, without parsing it again.
    return new Response(`{"watching":${watching},"age":${age},"status":${text}}`, {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  // The tab keeps the marker fresh while it's open; the grade app does while an offload the owner started goes.
  if ((path === "footage/watch" || path === "helper/footage/watch") && request.method === "POST") {
    await media.put(WATCHING, String(now + WATCH_TTL), { httpMetadata: { contentType: "text/plain" } });
    return json({ watching: true });
  }
  if (path === "footage/watch" && request.method === "DELETE") {
    await media.delete(WATCHING);
    return json({ watching: false });
  }
  if (path === "helper/footage" && request.method === "GET") return json({ watching: await isWatched(media, now) });
  if (path === "helper/footage" && request.method === "POST") {
    const declared = Number(request.headers.get("Content-Length"));
    if (declared > MAX_STATUS) return json({ error: "The footage status is too big" }, 413);
    const text = await request.text();
    if (text.length > MAX_STATUS) return json({ error: "The footage status is too big" }, 413);
    let status: unknown;
    try {
      status = JSON.parse(text);
    } catch {
      status = null;
    }
    if (!status || typeof status !== "object" || Array.isArray(status))
      return json({ error: "Send the footage status as an object" }, 400);
    const [watching] = await Promise.all([
      isWatched(media, now),
      media.put(STATUS, text, { httpMetadata: { contentType: "application/json" } }),
    ]);
    return json({ watching });
  }
  return null;
}
