// Offloading: the camera's originals, or Movies/Original's, go to the site's archive, each checked by its SHA-256, so
// the card or the Mac can be cleared of them and they can be graded, previewed and brought back later. Each shoot day
// is a manifest of its own in the archive, `_originals-<day>`, holding its clips as `assets/<file>`. It's saved again
// after every clip, so a clip is safe the moment it's in. The ledger counts an archived file the original's size as
// the original in Cloudflare; the leading `_` keeps these out of the films. `bun run publisher restore
// _originals-<day>` brings a day back.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { PART, readRange } from "../publisher/archive.mjs";

export const originalsName = (day) => `_originals-${day}`;

/** Thrown when the offload is stopped: not a failure, and what's in stays in. */
export class Stopped extends Error {
  constructor() {
    super("Stopped offloading");
  }
}

export async function hashFile(abs, signal = null) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(abs, { highWaterMark: 8 << 20, signal: signal ?? undefined }))
    hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Sends one file to the archive under its hash: whole up to `part`, else in parts, two at a time. `onBytes` hears each
 * request's bytes land; aborting `signal` stops between parts and gives the part-sent file up.
 */
export async function sendBlob(request, { abs, size }, hash, { part = PART, signal = null, onBytes = () => {} } = {}) {
  if (signal?.aborted) throw new Stopped();
  if (size <= part) {
    await request(`blobs/${hash}`, { method: "PUT", body: await readRange(abs, 0, size) });
    onBytes(size);
    return;
  }
  const { upload } = await request("uploads", { method: "POST", json: { blob: hash } });
  const count = Math.ceil(size / part);
  const parts = [];
  try {
    for (let first = 1; first <= count; first += 2) {
      if (signal?.aborted) throw new Stopped();
      const batch = [];
      for (let n = first; n < first + 2 && n <= count; n++) {
        const offset = (n - 1) * part;
        const length = Math.min(part, size - offset);
        batch.push(
          readRange(abs, offset, length)
            .then((body) =>
              request(`uploads/${hash}/${n}?upload=${encodeURIComponent(upload)}`, { method: "PUT", body }),
            )
            .then((sent) => {
              onBytes(length);
              return sent;
            }),
        );
      }
      parts.push(...(await Promise.all(batch)));
    }
    await request(`uploads/${hash}/complete`, { method: "POST", json: { upload, parts } });
  } catch (error) {
    await request(`uploads/${hash}?upload=${encodeURIComponent(upload)}`, { method: "DELETE" }).catch(() => {});
    throw error;
  }
}

/** A day's manifest as last archived: its files by path, or none yet. */
async function dayFiles(request, day) {
  try {
    const manifest = await request(`projects/${originalsName(day)}`);
    return new Map(manifest.files.map((file) => [file.path, file]));
  } catch (error) {
    if (/No such archived project/.test(error.message)) return new Map();
    throw error;
  }
}

/**
 * Offloads `clips` ([{ name, path, size, mtime, day }]) in order: hash each, send it unless the archive has it, then
 * save its day's manifest with it. `landed(clip, sha256)` hears each clip once it's safe; `progress({ name, sent, size })`
 * hears its bytes. Aborting `signal` stops it; what's in stays in. Says how many went in and how many bytes were sent.
 */
export async function offload(clips, { request, part = PART, signal = null, landed = () => {}, progress = () => {} }) {
  const days = new Map();
  let done = 0;
  let sentBytes = 0;
  for (const clip of clips) {
    if (signal?.aborted) return { done, sent: sentBytes, stopped: true };
    try {
      progress({ name: clip.name, sent: 0, size: clip.size, hashing: true });
      const sha256 = await hashFile(clip.path, signal);
      const { missing } = await request("missing", { method: "POST", json: { blobs: [sha256] } });
      let sent = 0;
      if (missing.length) {
        await sendBlob(request, { abs: clip.path, size: clip.size }, sha256, {
          part,
          signal,
          onBytes: (bytes) => {
            sent += bytes;
            sentBytes += bytes;
            progress({ name: clip.name, sent, size: clip.size });
          },
        });
      }
      if (!days.has(clip.day)) days.set(clip.day, await dayFiles(request, clip.day));
      const files = days.get(clip.day);
      files.set(`assets/${clip.name}`, { path: `assets/${clip.name}`, sha256, size: clip.size, mtime: clip.mtime });
      await request(`projects/${originalsName(clip.day)}`, {
        method: "PUT",
        json: { files: [...files.values()], folders: [] },
      });
      done++;
      landed(clip, sha256);
    } catch (error) {
      if (error instanceof Stopped || signal?.aborted) return { done, sent: sentBytes, stopped: true };
      throw error;
    }
  }
  return { done, sent: sentBytes, stopped: false };
}
