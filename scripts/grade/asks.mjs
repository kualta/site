// Start and Pause for each of the offload's switches, from the composer's Footage tab. The site keeps the owner's last ask
// of each switch with when it was asked (`footage/lanes.json`); this Mac hears them in the answers it already gets (the
// pause check's, every 30 seconds, and its reports'), and does each once: a Start turns the switch on, a Pause stops it
// once what's in flight is done. What it has done is kept in a file of its own (`asked.json`), so a restart doesn't do
// any again, and one asked while the app wasn't running is done when it is. The report says which it has taken, and why
// one couldn't be done, so the tab can tell an ask still on its way.
//
// The last ask wins, from wherever: the switches in the grade app's own menu work as before, and the tab's next ask
// overrides what they did.

export const LANES = ["copy", "send"];

/** An ask as the site says it, or null if it isn't one. */
function readAsk(value) {
  if (!["start", "pause"].includes(value?.want) || !Number.isFinite(value?.at)) return null;
  return { want: value.want, at: value.at };
}

/**
 * The switches' asks. `store` keeps what's been done (`read()`, `write(done)`): by switch, `{ at, error }`. `apply(lane,
 * want)` does an ask, saying false when it can't be done yet (asked again at the next answer), and throwing when it
 * can't be done at all. `changed()` hears each one taken. Nothing is done until `start()`, so the app is up first.
 */
export function laneAsks({ store, apply, changed = () => {}, log = (line) => console.error(`grade: asks: ${line}`) }) {
  /** What's been done of each switch's asks. */
  let done = {};
  /** The asks as last heard. */
  let latest = {};
  let started = false;
  let working = false;
  let again = false;

  async function work() {
    if (working) {
      again = true;
      return;
    }
    working = true;
    try {
      do {
        again = false;
        for (const lane of LANES) {
          const ask = latest[lane];
          if (!ask || ask.at <= (done[lane]?.at ?? 0)) continue;
          let error = null;
          try {
            if (!(await apply(lane, ask.want))) continue;
          } catch (failed) {
            error = failed.message;
            log(`couldn't ${ask.want} ${lane}: ${error}`);
          }
          done = { ...done, [lane]: { at: ask.at, error } };
          await store.write(done).catch((failed) => log(`couldn't keep what's been asked: ${failed.message}`));
          changed();
        }
      } while (again);
    } finally {
      working = false;
    }
  }

  return {
    /** Takes the asks from an answer of the site's (its `lanes`); one that has none changes nothing. */
    learn(asks) {
      if (!asks || typeof asks !== "object") return;
      latest = Object.fromEntries(LANES.map((lane) => [lane, readAsk(asks[lane])]));
      if (started) void work();
    },
    /** What's been done of each switch's asks, for the report. */
    heard: () => done,
    async start() {
      done = (await store.read().catch(() => null)) ?? {};
      started = true;
      await work();
    },
  };
}
