/**
 * Sizes every image under `public/` and keeps the result in
 * `src/data/image-sizes.json`.
 *
 * The layout needs an image's real dimensions to declare og:image:width, and it
 * has to do that for the homepage too, which renders on demand on a worker
 * where `public/` does not exist as files. So the sizes are baked into a plain
 * JSON import instead of being read at request time.
 *
 * Regenerated whenever the config loads, so adding an image is enough; the file
 * is committed only so a fresh clone type-checks before its first build.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { imageSize } from "./image-size.mjs";

const EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);

/**
 * Cover art is extracted from the audio at build time and gitignored, so
 * including it would rewrite this file on every build. Nothing needs its size
 * anyway: the labels are drawn into a square the stylesheet already sizes.
 */
const SKIP = new Set(["music/covers"]);

function walk(dir, base, into) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full).split(path.sep).join("/");
    if (SKIP.has(relative)) continue;

    if (entry.isDirectory()) {
      walk(full, base, into);
    } else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const size = imageSize(full);
      // the leading slash matches how the site refers to these: "/images/..."
      if (size) into[`/${relative}`] = size;
    }
  }
}

export function buildImageManifest(root = process.cwd()) {
  const publicDir = path.join(root, "public");
  const target = path.join(root, "src/data/image-sizes.json");

  const sizes = {};
  try {
    walk(publicDir, publicDir, sizes);
  } catch {
    return {};
  }

  // sorted so the committed file has no incidental churn between machines
  const ordered = Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)));
  const serialized = `${JSON.stringify(ordered, null, 2)}\n`;

  // only touch the file on a real change, or the dev server reloads forever
  let current = null;
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== serialized) writeFileSync(target, serialized);

  return ordered;
}
