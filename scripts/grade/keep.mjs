// What the owner is keeping on this Mac: whole shoot days, and clips by name, among them those brought back from the
// archive to work on. The offload copies them off the card like any other, but never sends them and never deletes them
// from the Mac. The list is a file, read each time it's asked, so a clip kept a moment before it would have been
// deleted from the Mac stays; a file that can't be read keeps everything.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stemOf } from "./ledger.mjs";

const keyOf = (name) => stemOf(name).toLowerCase();
const isDay = (day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day);
const isClip = (clip) => typeof clip === "string" && /^[^/\\]{1,255}$/.test(clip);

const refuse = (message) => Object.assign(new Error(message), { status: 400 });
/** A list's entries, once each and in order. */
function entries(list, isOne, what) {
  if (!Array.isArray(list) || !list.every(isOne)) throw refuse(what);
  return [...new Set(list)].sort();
}
const dayList = (days) => entries(days, isDay, "days must be a list of dates like 2026-11-08");
const clipList = (clips) => entries(clips, isClip, "clips must be a list of file names");

export function keepList(path) {
  async function read() {
    try {
      const { days = [], clips = [] } = JSON.parse(await readFile(path, "utf8"));
      return { days: dayList(days), clips: clipList(clips) };
    } catch (error) {
      if (error.code === "ENOENT") return { days: [], clips: [] };
      throw new Error(`The list of kept clips can't be read, so none are offloaded: ${error.message}`);
    }
  }
  async function save(change) {
    const { days, clips } = change(await read());
    const list = { days: dayList(days), clips: clipList(clips) };
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.part`, `${JSON.stringify({ version: 1, ...list }, null, 2)}\n`);
    await rename(`${path}.part`, path);
    return list;
  }
  /** Changes to the list, one after another. */
  let saving = Promise.resolve();
  function update(change) {
    const saved = saving.then(() => save(change));
    saving = saved.catch(() => {});
    return saved;
  }
  return {
    read,
    /** Replaces the days, the clips or both; what isn't given stays. Says the list. */
    set: ({ days, clips }) =>
      update((list) => ({
        days: days === undefined ? list.days : days,
        clips: clips === undefined ? list.clips : clips,
      })),
    /** Keeps a clip by its name. Says how to let it go again: that does nothing if it was kept before. */
    async add(name) {
      let added = false;
      await update(({ days, clips }) => {
        added = !clips.includes(name);
        return { days, clips: [...clips, name] };
      });
      return async () => {
        if (added) await update(({ days, clips }) => ({ days, clips: clips.filter((clip) => clip !== name) }));
      };
    },
    /** Whether a clip (its `name`, whatever its extension, and shoot `day`) is kept, as the list stands now. */
    async keeping() {
      const { days, clips } = await read();
      const [keptDays, keptClips] = [new Set(days), new Set(clips.map(keyOf))];
      return ({ name, day }) => keptDays.has(day) || keptClips.has(keyOf(name));
    },
  };
}
