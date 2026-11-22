// The footage ledger: a record for every clip the grade app has seen, and for every graded clip the footage archive
// put on YouTube or a film put in the Cloudflare archive. Each says when the clip was recorded and in what profile,
// whether it's graded, and where its copies are: the original on the camera's card, on this Mac (Movies/Original) or
// in the Cloudflare archive; the graded copy on this Mac (Movies/Exported), in the Cloudflare archive or on YouTube.
//
// The grade app is the ledger's only writer. It looks every so often and merges what it sees into what it knew, so a
// clip taken off the card or the Mac keeps its record, and what can't be looked at now (the card unplugged, the
// archive not asked) stays as last seen. It keeps the ledger beside its other files and sends it to the site's
// archive (ledger/footage.json) whenever something in it changes.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { archiveClient } from "../publisher/archive.mjs";

export const LEDGER_VERSION = 1;
const DJI = /^DJI_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_\d+/i;
const VIDEO = /\.(mp4|mov)$/i;

export const stemOf = (name) => name.replace(/\.[^.]+$/, "");
const keyOf = (name) => stemOf(name).toLowerCase();

/** When the camera started a clip, from the clock in a DJI name ("2026-11-11T16:12:30"), else `fallback`. */
export function recordedAt(name, fallback = null) {
  const m = DJI.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : fallback;
}

/** A time as a local clock reads it, like the camera's in a DJI name: "2026-11-11T16:12:30". */
function localTime(ms) {
  const d = new Date(ms);
  const two = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(
    d.getMinutes(),
  )}:${two(d.getSeconds())}`;
}

/** Items by their clip, the file name without its extension, any case. */
function byClip(items) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item.name);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

const blank = (name, at) => ({
  name,
  recorded: recordedAt(name),
  profile: null,
  duration: null,
  size: null,
  original: { camera: false, mac: false, cloudflare: false },
  graded: null,
  gradePending: false,
  firstSeen: at,
});
const blankGraded = () => ({ look: null, at: null, size: null, mac: false, cloudflare: false, youtube: null });

/**
 * The ledger after looking again. `seen` is what the grade app sees now:
 *
 *   at        the time, ISO
 *   camera    { name, mounted, clips: [{ name, size }] }: the card's clips, when it's plugged in
 *   mac       [{ name, size, mtime }]: the originals in Movies/Original
 *   metas     Map of clip (lowercase name without extension) → { profile, duration }, for clips probed
 *   exports   exports.json's records, by original file name: what each graded copy was made with
 *   exported  [{ name, size }]: the graded copies in Movies/Exported
 *   grades    the names of clips with a saved grade
 *   youtube   footage.json's uploads, by graded file name → versions; null when it can't be read
 *   archive   [{ name, size, sha256, project }]: the video files the archive's projects hold; null when not asked
 *   projects  [{ name, files }]: the OpenFilm projects on this Mac, each with the video files in its assets
 *   transcripts  the names of clips whose transcripts are in the archive, beside their originals
 *
 * What isn't looked at keeps its last value: the card's clips while it's unplugged, the archive between askings.
 * A graded copy in the archive or on YouTube is the current one when its size is the export's.
 */
export function mergeLedger(previous, seen) {
  const clips = structuredClone(previous?.clips ?? {});
  const keys = new Map(Object.keys(clips).map((key) => [key.toLowerCase(), key]));
  const record = (name) => {
    const lower = keyOf(name);
    let key = keys.get(lower);
    if (!key) {
      key = stemOf(name);
      keys.set(lower, key);
      clips[key] = blank(name, seen.at);
    }
    return clips[key];
  };
  const lookup = (key) => clips[keys.get(key)];

  // Originals: on the card (only known while it's plugged in) and on this Mac.
  const onCard = byClip(seen.camera.mounted ? seen.camera.clips : []);
  const onMac = byClip(seen.mac);
  for (const [, [clip]] of onCard) record(clip.name);
  for (const [, [clip]] of onMac) {
    const entry = record(clip.name);
    entry.recorded ??= localTime(clip.mtime);
  }
  for (const [key, entry] of Object.entries(clips)) {
    const lower = key.toLowerCase();
    const card = onCard.get(lower)?.[0];
    const mac = onMac.get(lower)?.[0];
    if (seen.camera.mounted) entry.original.camera = Boolean(card);
    entry.original.mac = Boolean(mac);
    if (card || mac) {
      entry.name = (card ?? mac).name;
      entry.size = (card ?? mac).size;
    }
    const meta = seen.metas.get(lower);
    if (meta) {
      entry.profile = meta.profile ?? entry.profile;
      entry.duration = meta.duration ?? entry.duration;
    }
  }

  // Graded copies: what exports.json says each was made with, and the file in Movies/Exported.
  const records = byClip(Object.entries(seen.exports).map(([name, value]) => ({ name, value })));
  const exported = byClip(seen.exported);
  for (const [, [{ name, value }]] of records) {
    const entry = record(name);
    entry.profile ??= value.profile ?? null;
    entry.graded ??= blankGraded();
    entry.graded.look = value.base?.name ?? entry.graded.look;
    entry.graded.at = value.exportedAt ?? entry.graded.at;
  }
  for (const [, [file]] of exported) {
    const entry = record(file.name);
    entry.graded ??= blankGraded();
    entry.graded.size = file.size;
    entry.graded.at ??= new Date(file.mtime).toISOString();
  }
  const withGrade = new Set([...seen.grades].map(keyOf));
  for (const [key, entry] of Object.entries(clips)) {
    const lower = key.toLowerCase();
    if (entry.graded) entry.graded.mac = exported.has(lower);
    entry.gradePending = !entry.graded && withGrade.has(lower);
  }

  // YouTube: the footage archive's uploads, each a graded copy.
  if (seen.youtube) {
    const uploads = byClip(Object.entries(seen.youtube).map(([name, versions]) => ({ name, versions })));
    for (const [, [{ name }]] of uploads) record(name).graded ??= blankGraded();
    for (const [key, entry] of Object.entries(clips)) {
      if (!entry.graded) continue;
      const versions = uploads.get(key.toLowerCase())?.[0].versions ?? [];
      const latest = versions.at(-1);
      entry.graded.size ??= latest?.size ?? null;
      entry.graded.youtube = latest
        ? { video: latest.video, at: latest.uploadedAt, current: latest.size === entry.graded.size }
        : null;
    }
  }

  // The Cloudflare archive: a file of the clip's that's the original's size is the original; any other is graded.
  if (seen.archive) {
    const archived = byClip(seen.archive);
    for (const [lower, [file]] of archived) if (DJI.test(file.name) && !lookup(lower)) record(file.name);
    for (const [key, entry] of Object.entries(clips)) {
      const files = archived.get(key.toLowerCase()) ?? [];
      entry.original.cloudflare = entry.size !== null && files.some((file) => file.size === entry.size);
      const copies = files.filter((file) => file.size !== entry.size);
      // A graded copy only the archive holds, or whose export left the Mac before its size was seen, weighs what the
      // archive's copy does.
      if (copies.length) {
        entry.graded ??= blankGraded();
        entry.graded.size ??= copies.at(-1).size;
      }
      if (!entry.graded) continue;
      if (!copies.length) entry.graded.cloudflare = false;
      else if (entry.graded.size === null || copies.some((file) => file.size === entry.graded.size))
        entry.graded.cloudflare = "current";
      else entry.graded.cloudflare = "earlier";
    }
  }

  for (const name of seen.transcripts ?? []) {
    const entry = lookup(keyOf(name));
    if (entry) entry.transcript = true;
  }

  // Films: the ledger's clips each OpenFilm project holds, on this Mac and in the archive. Between askings of the
  // archive, its films are as last seen.
  const projects = {};
  const film = (name) => {
    projects[name] ??= { clips: [], local: false, archived: false };
    return projects[name];
  };
  const holds = (name, file) => {
    const key = keys.get(keyOf(file));
    if (key && !film(name).clips.includes(key)) film(name).clips.push(key);
  };
  for (const { name, files } of seen.projects ?? []) {
    film(name).local = true;
    for (const file of files) holds(name, file);
  }
  if (seen.archive)
    for (const file of seen.archive) {
      // A day's offloaded originals (`_originals-<day>`) aren't a film.
      if (file.project.startsWith("_")) continue;
      film(file.project).archived = true;
      holds(file.project, file.name);
    }
  else
    for (const [name, project] of Object.entries(previous?.projects ?? {}))
      if (project.archived) {
        film(name).archived = true;
        for (const key of project.clips) holds(name, key);
      }
  for (const project of Object.values(projects)) project.clips.sort();

  const sorted = Object.fromEntries(Object.entries(clips).sort(([a], [b]) => a.localeCompare(b)));
  return {
    version: LEDGER_VERSION,
    updatedAt: seen.at,
    camera: {
      name: seen.camera.name,
      mounted: seen.camera.mounted,
      // When the card was last looked at: its clips are as of then while it's unplugged.
      seenAt: seen.camera.mounted ? seen.at : previous?.camera?.seenAt ?? null,
    },
    archiveAt: seen.archive ? seen.at : previous?.archiveAt ?? null,
    clips: sorted,
    projects: Object.fromEntries(Object.entries(projects).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** The ledger without the times that move on every look, to tell whether anything in it changed. */
export function comparable(ledger) {
  if (!ledger) return "";
  return JSON.stringify({
    ...ledger,
    updatedAt: null,
    archiveAt: null,
    camera: { ...ledger.camera, seenAt: null },
  });
}

/** This Mac's ledger with any clip only the archive's copy has (one recorded on another Mac, or before a reset). */
export function unionLedgers(local, cloud) {
  if (!local) return cloud ?? null;
  if (!cloud?.clips) return local;
  const known = new Set(Object.keys(local.clips).map((key) => key.toLowerCase()));
  const extra = Object.entries(cloud.clips).filter(([key]) => !known.has(key.toLowerCase()));
  return extra.length ? { ...local, clips: { ...local.clips, ...Object.fromEntries(extra) } } : local;
}

/**
 * The video files the archive's projects hold (in assets/, or zh/assets/ for a Chinese version), each with its size,
 * hash and project. A project's manifest is read once each time it's archived: `cache` keeps them (project →
 * { archivedAt, files }) between calls.
 */
export async function archivedFootage(request, cache = new Map()) {
  const files = [];
  for (const { name, archivedAt } of (await request("projects")).projects) {
    let known = cache.get(name);
    if (known?.archivedAt !== archivedAt) {
      const manifest = await request(`projects/${encodeURIComponent(name)}?at=${encodeURIComponent(archivedAt)}`);
      known = {
        archivedAt,
        files: manifest.files
          .filter((file) => /^(zh\/)?assets\//.test(file.path) && VIDEO.test(file.path))
          .map((file) => ({ name: file.path.split("/").pop(), size: file.size, sha256: file.sha256 })),
      };
      cache.set(name, known);
    }
    for (const file of known.files) files.push({ ...file, project: name });
  }
  return files;
}

/** The footage archive's YouTube uploads, from the crossposter helper's footage.json: {} before any, null unreadable. */
export async function youtubeUploads(publisherDir) {
  try {
    return JSON.parse(await readFile(join(publisherDir, "footage.json"), "utf8")).clips ?? {};
  } catch (error) {
    return error.code === "ENOENT" ? {} : null;
  }
}

/** A clip name the archive keeps a picture under: letters, digits, `_`, `-` and `.`, as camera and phone names are. */
export const pictureName = (clip) => /^[\w-][\w.-]{0,119}$/.test(clip);

/**
 * The site's archive, reached on the crossposter helper's pairing (its config.json): the archive's own requests, the
 * ledger read and written whole, and a clip's small picture sent. Null while the helper isn't paired.
 */
export async function ledgerCloud(publisherDir, fetcher = fetch) {
  let config;
  try {
    config = JSON.parse(await readFile(join(publisherDir, "config.json"), "utf8"));
  } catch {
    return null;
  }
  const { origin, token } = config;
  if (!origin || !token) return null;
  const url = `${origin}/api/publisher/helper/archive/ledger`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    request: archiveClient({ origin, token, fetcher }),
    /** The ledger as last sent, or null before the first. */
    async read() {
      const response = await fetcher(url, { headers: auth, signal: AbortSignal.timeout(60_000) });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Reading the ledger failed (${response.status})`);
      return response.json();
    },
    async write(ledger) {
      const response = await fetcher(url, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify(ledger),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Saving the ledger failed (${response.status})`);
      }
    },
    /**
     * Counts the composer as watching the footage uploads for the next couple of minutes, so the helper puts graded
     * clips up to YouTube while an offload the owner started goes.
     */
    async watchFootage() {
      const response = await fetcher(`${origin}/api/publisher/helper/footage/watch`, {
        method: "POST",
        // Without a type Astro refuses it as a cross-site form submission.
        headers: { ...auth, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Keeping the footage uploads going failed (${response.status})`);
    },
    /** A clip's small picture (JPEG bytes), for the composer's Footage tab. */
    async putThumb(clip, bytes) {
      const response = await fetcher(`${url}/thumbs/${encodeURIComponent(clip)}`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "image/jpeg" },
        body: bytes,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Sending a picture failed (${response.status})`);
      }
    },
  };
}
