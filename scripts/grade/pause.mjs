// Pause all, from the composer's Footage tab. The site keeps the flag, so it holds from a phone and through restarts; this
// Mac hears it in the answers to its reports (report.mjs), and asks for it at start and every 30 seconds otherwise.
//
// `held()` is the one check every job here honours, and whatever's added next should too: the offload's switches,
// Whisper, the transcripts it sends, exports, and clips brought back from Cloudflare. Paused, nothing new starts; what's
// in flight finishes its part (an upload), its file (a copy, an export, a clip brought back) or its clip (Whisper), and
// each goes on from there once it's resumed.

export const HELD = "Paused from the Footage tab";

/**
 * The flag as last heard. `ask()` asks the site, saying its answer (`{ paused }`) or null when this Mac isn't paired;
 * `learn(paused)` takes `paused` from any other answer. `changed(held)` hears it pause and resume.
 */
export function pauseFlag({
  ask,
  every = 30_000,
  clock = Date.now,
  changed = () => {},
  log = (line) => console.error(`grade: pause: ${line}`),
}) {
  /** Since when everything's paused, by the site's clock; null while it isn't. */
  let since = null;
  let heardAt = Number.NEGATIVE_INFINITY;
  let failed = null;
  let timer = null;

  function learn(paused) {
    heardAt = clock();
    const next = typeof paused?.since === "number" ? paused.since : null;
    if (next === since) return;
    since = next;
    log(since === null ? "going on, as the Footage tab says" : "paused from the Footage tab");
    changed(since !== null);
  }
  /** Asks the site, unless an answer said within `every`. */
  async function check() {
    if (clock() - heardAt < every) return;
    // Asked or not, the next asking waits its turn.
    heardAt = clock();
    try {
      const answer = await ask();
      if (answer) learn(answer.paused ?? null);
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
    learn,
    check,
    start() {
      void check();
      timer = setInterval(check, Math.min(5_000, every));
    },
    stop() {
      clearInterval(timer);
    },
  };
}
