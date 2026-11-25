// Pause all, from the composer's Footage tab. The site keeps the flag, so it holds from a phone and through restarts; this
// Mac hears it in the answers to its reports (report.mjs), and asks for it at start and every 30 seconds otherwise: every
// 4 while the Footage tab is open, which the same answers say, so a Start, Pause or Pause all there is heard within
// seconds. Each asking is a row read of the site's D1 (its pairing), so it's only that quick while someone's looking.
//
// `held()` is the one check every job here honours, and whatever's added next should too: the offload's switches,
// Whisper, the transcripts it sends, exports, and clips brought back from Cloudflare. Paused, nothing new starts; what's
// in flight finishes its part (an upload), its file (a copy, an export, a clip brought back) or its clip (Whisper), and
// each goes on from there once it's resumed.

export const HELD = "Paused from the Footage tab";

/**
 * The flag as last heard. `ask()` asks the site, saying its answer (`{ paused, watching }`) or null when this Mac isn't
 * paired; `learn(paused, watching)` takes them from any other answer, `watching` being whether the Footage tab is open.
 * `changed(held)` hears it pause and resume. `check()` asks the site once `every` has gone by since it last answered, or
 * `watchedEvery` while the tab is open; the reporter's looks (report.mjs) call it, so it's never asked as a report goes.
 */
export function pauseFlag({
  ask,
  every = 30_000,
  watchedEvery = 4_000,
  clock = Date.now,
  changed = () => {},
  log = (line) => console.error(`grade: pause: ${line}`),
}) {
  /** Since when everything's paused, by the site's clock; null while it isn't. */
  let since = null;
  let watched = false;
  let heardAt = Number.NEGATIVE_INFINITY;
  let failed = null;

  function learn(paused, watching) {
    heardAt = clock();
    // An answer from a site that doesn't say leaves it as it was.
    if (typeof watching === "boolean") watched = watching;
    const next = typeof paused?.since === "number" ? paused.since : null;
    if (next === since) return;
    since = next;
    log(since === null ? "going on, as the Footage tab says" : "paused from the Footage tab");
    changed(since !== null);
  }
  /** Asks the site, unless an answer said within `every` (or `watchedEvery`). */
  async function check() {
    if (clock() - heardAt < (watched ? Math.min(watchedEvery, every) : every)) return;
    // Asked or not, the next asking waits its turn.
    heardAt = clock();
    try {
      const answer = await ask();
      if (answer) learn(answer.paused ?? null, answer.watching);
      if (failed) log("reaching the site again");
      failed = null;
    } catch (error) {
      if (error.message !== failed) log(`couldn't ask the site: ${error.message}`);
      failed = error.message;
    }
  }

  return {
    /** Why everything waits, or null. */
    held: () => (since === null ? null : HELD),
    get since() {
      return since;
    },
    /** Whether the Footage tab is open, as the site last said. */
    get watched() {
      return watched;
    },
    learn,
    check,
  };
}
