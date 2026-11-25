// Notices the camera's card being plugged in or pulled out as it happens, so the Footage tab says so within seconds and
// Camera → Mac doesn't sit out its wait. It watches the folder volumes appear in (`/Volumes`, for
// `/Volumes/Pocket4P/DCIM`), never the card itself, so nothing here holds it as it's ejected; and looks every few
// seconds too, in case the watch misses one or can't be had.
import { watch as watchFolder } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Whether `path` (the card's folder of clips) is there, as last looked. `changed(mounted)` hears each change. A change
 * the watch sees is looked at again after `settle`, as a volume can take a moment to be readable whole.
 */
export function mountWatch(path, { changed, every = 3_000, settle = 1_500, watch = watchFolder }) {
  /** As last looked; null before the first look. */
  let mounted = null;
  let looking = null;
  let again = false;
  let timer = null;
  let watcher = null;
  let settling = null;

  async function lookNow() {
    do {
      again = false;
      const now = await stat(path).then(
        (found) => found.isDirectory(),
        () => false,
      );
      const was = mounted;
      mounted = now;
      if (was !== null && was !== now) changed(now);
    } while (again);
  }
  /** Looks, once at a time: asked meanwhile, it looks again after. */
  function look() {
    if (looking) {
      again = true;
      return looking;
    }
    looking = lookNow().finally(() => {
      looking = null;
    });
    return looking;
  }
  /** Something changed where volumes appear: looked at now, and again once it's settled. */
  function seen() {
    void look();
    clearTimeout(settling);
    settling = setTimeout(look, settle);
  }

  return {
    get mounted() {
      return mounted;
    },
    look,
    start() {
      void look();
      try {
        watcher = watch(dirname(dirname(path)), seen);
        watcher.on("error", () => {
          watcher?.close();
          watcher = null;
        });
      } catch {
        // Not there to watch: the looks do.
      }
      timer = setInterval(look, every);
    },
    stop() {
      clearInterval(timer);
      clearTimeout(settling);
      watcher?.close();
      watcher = null;
    },
  };
}
