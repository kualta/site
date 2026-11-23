// The ledger's small pictures as the archive gets them, for the composer's Footage and Archive tabs: graded the way their
// clip would export, through its saved grade or else its profile's default look (resolveGrade). They're graded from the
// log picture the cache keeps (media.mjs makeThumb), with what the clip's original was probed as, so a picture can be
// graded again after its clip has left this Mac. Each clip's record says what its picture went through (`thumb`: that
// grade's key, or `true` for one sent as it was made), and a picture goes again only when that changes.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { composeLut, gradeKey, normalizeGrade, resolveGrade } from "./color.mjs";
import { pictureName, stemOf } from "./ledger.mjs";
import { gradeStill } from "./media.mjs";

/** The record of a picture sent as it was made: ungraded, as every one was before they were graded. */
export const AS_MADE = true;
/** Pictures sent at most each look, as before they were graded. */
export const THUMBS_AT_ONCE = 24;

/** A still takes all of a grade but deflicker, which only an export does. */
const stillGrade = ({ deflicker, ...grade }) => grade;
const UNGRADED = gradeKey(normalizeGrade({ base: "none" }));
const clipOf = (name) => stemOf(basename(name)).toLowerCase();

/** The key a picture graded through `grade` is recorded under: short, as the tabs ask for the picture by it. */
export const thumbKey = (grade) =>
  createHash("sha256")
    .update(`thumb 1\n${gradeKey(stillGrade(grade))}`)
    .digest("hex")
    .slice(0, 12);

/**
 * What sends the pictures: `send` once a look. It keeps the last few LUTs it made, and what it has logged, so a clip that
 * can't be graded is logged once.
 */
export function thumbSender({ lutSize = 65, warn = (message) => console.warn(message) } = {}) {
  const luts = new Map();
  const told = new Set();
  /** Clips whose grading failed, each with the key it failed on: it goes as made until its grade changes. */
  const failed = new Map();
  const once = (message) => {
    if (told.has(message)) return;
    told.add(message);
    warn(message);
  };

  /** What a clip's picture is to be: `{ key }` to go as made, or with the grade, look and original to grade it by. */
  function wanted(clip, { copies, probed, grades, bases }) {
    const k = clip.toLowerCase();
    const meta = probed.get(k);
    if (copies.has(k) || !meta?.profile) return { key: AS_MADE };
    const available = bases[meta.profile] ?? [];
    const saved = grades.get(k);
    const grade = resolveGrade(
      saved,
      available.map((b) => b.id),
    );
    if (grade.base === "none" && meta.profile !== "rec709" && saved?.base !== "none") {
      once(`${clip}: no LUT for its look, so its picture goes ungraded`);
      return { key: AS_MADE };
    }
    // Rec.709 as shot, or any clip as shot and left alone.
    if (gradeKey(stillGrade(grade)) === UNGRADED) return { key: AS_MADE };
    const key = thumbKey(grade);
    if (failed.get(k) === key) return { key: AS_MADE };
    return { key, grade, look: available.find((b) => b.id === grade.base), meta };
  }

  /** The LUT an export of the clip would bake, at its size. */
  async function lutFor({ grade, look, meta }, loadCube) {
    const base = look.file ? await loadCube(look.file) : null;
    // The camera's white balance only counts to a grade that sets its own, or a tint (adjuster).
    const shotK = grade.kelvin === null && !grade.tint ? null : meta.cameraKelvin;
    const id = [meta.profile, look.file, gradeKey(stillGrade(grade)), shotK].join("\n");
    const hit = luts.get(id);
    if (hit?.base === base) return hit.lut;
    const data = composeLut({ profile: meta.profile, grade, shotK, base, size: lutSize });
    const lut = { size: lutSize, data, min: [0, 0, 0], max: [1, 1, 1] };
    luts.set(id, { base, lut });
    if (luts.size > 8) luts.delete(luts.keys().next().value);
    return lut;
  }

  /**
   * Sends the archive the pictures it hasn't got as they now are, `at` at most, and marks each clip's record with what
   * its picture went through. Says whether more are waiting, and why a send failed (and sending stopped), if one did.
   *
   *   clips     the ledger's records, by clip
   *   files     the cache's pictures: clip (lowercase) → path
   *   copies    the clips (lowercase) whose picture was made from the graded copy: it goes as made
   *   probed    the cache's meta.json records, by the original's path: what each clip was probed as
   *   grades    grades.json's clips, by file name
   *   bases     the looks for each profile, as the app has them ({ id, file })
   *   loadCube  a look's file → its parsed LUT
   *   put       (clip, JPEG bytes) → sent
   */
  async function send({ clips, files, copies, probed, grades, bases, loadCube, put, at = THUMBS_AT_ONCE }) {
    const context = {
      copies,
      probed: new Map(Object.entries(probed).map(([path, record]) => [clipOf(path), record.meta])),
      grades: new Map(Object.entries(grades).map(([name, grade]) => [clipOf(name), grade])),
      bases,
    };
    const waiting = [];
    for (const [clip, record] of Object.entries(clips)) {
      const file = files.get(clip.toLowerCase());
      if (!file || !pictureName(clip)) continue;
      const want = wanted(clip, context);
      if (record.thumb !== want.key) waiting.push({ clip, record, file, want });
    }
    for (const { clip, record, file, want } of waiting.slice(0, at)) {
      const made = await readFile(file).catch(() => null);
      if (!made) continue;
      let bytes = made;
      let key = want.key;
      if (want.grade)
        try {
          bytes = await gradeStill(made, await lutFor(want, loadCube), { matrix: want.meta.matrix });
        } catch (e) {
          failed.set(clip.toLowerCase(), key);
          once(`${clip}: grading its picture failed, so it goes ungraded: ${e.message}`);
          key = AS_MADE;
          if (record.thumb === key) continue;
        }
      try {
        await put(clip, bytes);
      } catch (e) {
        return { more: false, error: e.message };
      }
      record.thumb = key;
    }
    return { more: waiting.length > at, error: null };
  }

  return { send };
}
