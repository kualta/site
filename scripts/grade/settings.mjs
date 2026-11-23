// The grade app's settings in the archive: every clip's grade and what each export was made with, as the `_settings`
// project (`bun run publisher restore _settings <folder>` brings them back). Never the LUTs, which are big and others'.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

export const SETTINGS = "_settings";

/** A settings file as it is now, or null when there's none. */
async function settingsFile(path) {
  try {
    const [body, { mtimeMs }] = await Promise.all([readFile(path), stat(path)]);
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { path: basename(path), body, sha256, size: body.length, mtime: Math.round(mtimeMs) };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Saves the files at `paths` in the archive, if they're not as they were when `last` (what this said) was. Says what they
 * are now. Nothing is asked of the archive when nothing has changed.
 */
export async function saveSettings(request, paths, last = null) {
  const files = (await Promise.all(paths.map(settingsFile))).filter(Boolean);
  const now = files.map(({ path, sha256 }) => `${path} ${sha256}`).join("\n");
  if (!files.length || now === last) return last;
  const { missing } = await request("missing", { method: "POST", json: { blobs: files.map((file) => file.sha256) } });
  for (const { sha256, body } of files)
    if (missing.includes(sha256)) await request(`blobs/${sha256}`, { method: "PUT", body });
  const listed = files.map(({ path, sha256, size, mtime }) => ({ path, sha256, size, mtime }));
  await request(`projects/${SETTINGS}`, { method: "PUT", json: { files: listed, folders: [] } });
  return now;
}
