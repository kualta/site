// The looks the grades use, as small LUTs for the settings backup: each base look a backed-up grade names (and each
// profile's default look, which a clip without one starts on), at 33³ per profile that has it, resampled from the app's
// own .cube as `composeLut` samples it. The composer's Archive tab grades an original with them in the browser, the way
// the app's preview does; the app's LUT folder itself (777 MB, much of it others' and not to be passed on) never goes
// up. The archive bucket is private, and so are these: the Fujifilm packs are for personal, noncommercial use.
import { composeLut, DEFAULT_LOOKS, writeCube } from "./color.mjs";

export const LOOK_SIZE = 33;
/** Where a look's LUT for a profile is filed in `_settings`. */
export const lookPath = (profile, id) => `looks/${profile}/${encodeURIComponent(id)}.cube`;

/** The looks `grades` (grades.json's clips) name, with the first default look each profile has. */
export function looksInUse(grades, bases) {
  const named = new Set();
  for (const grade of Object.values(grades ?? {}))
    if (typeof grade?.base === "string" && grade.base !== "none") named.add(grade.base);
  return Object.fromEntries(
    Object.entries(bases).map(([profile, available]) => {
      const ids = new Set(named);
      const first = DEFAULT_LOOKS.find((id) => available.some((base) => base.id === id));
      if (first) ids.add(first);
      return [profile, available.filter((base) => base.file && ids.has(base.id))];
    }),
  );
}

const made = new Map();
/**
 * Each look in use as a file for the backup: `{ path, body, mtime }`, by profile. `bases` is the app's looks per profile
 * (`{ id, name, file }`), and `read(file)` gives a look's parsed .cube and its file's modified time. A look is made again
 * only when its file has changed.
 */
export async function lookFiles({ grades, bases, read }) {
  const files = [];
  for (const [profile, looks] of Object.entries(looksInUse(grades, bases)))
    for (const { id, name, file } of looks) {
      const { lut, mtime } = await read(file);
      const key = `${profile}\n${file}\n${mtime}`;
      if (!made.has(key)) {
        const data = composeLut({ profile, grade: {}, shotK: null, base: lut, size: LOOK_SIZE });
        made.set(key, new TextEncoder().encode(writeCube(LOOK_SIZE, data, `${name} · ${profile} · grade app`)));
      }
      files.push({ path: lookPath(profile, id), body: made.get(key), mtime: Math.round(mtime) });
    }
  return files;
}
