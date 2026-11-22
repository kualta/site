// One of the offload's switches as it goes: on until there's nothing left for it to do, or it's stopped.
//
//   off ── start ──▶ on ── nothing left ──▶ off ("done")
//                    ├── stop ──▶ finishing: what's in flight is seen through and nothing new begun ──▶ off ("stopped")
//                    └── stop again, or now ──▶ stopping: what's in flight is cut ──▶ off ("stopped")
//
// What gets in a lane's way (the camera unplugged, the network down) it waits out, longer each time. A clip that keeps
// failing is passed over, saying why, so one can't hold up the rest.

/** How long a lane waits before its first try again and at most, and how often it tries one clip. */
export const RETRY = { first: 30_000, most: 10 * 60_000, tries: 5 };

/** A lane. `shape` is what its state says beyond every lane's; `log` hears each clip passed over. */
export function makeLane(shape = {}, { retry = RETRY, log = () => {} } = {}) {
  const blank = () => ({
    on: false,
    mode: "off",
    total: 0,
    bytes: 0,
    done: 0,
    doneBytes: 0,
    /** What it's waiting for, and why: `{ for, why, until }`. */
    waiting: null,
    /** Clips passed over: `{ name, why }`. */
    skipped: [],
    finished: null,
    error: null,
    ...structuredClone(shape),
  });
  const state = blank();
  let cut = new AbortController();
  /** Failures since something last went right: how long the next wait is. */
  let failures = 0;
  let recovering = null;
  /** Clips that failed: name → `{ tries, until }`. */
  const failing = new Map();
  const passed = new Set();
  const waits = [];
  const resting = new Set();

  const ending = () => state.mode !== "on";
  const delay = (n) => Math.min(retry.most, retry.first * 2 ** (n - 1));

  /** Says what it's waiting for until `over` settles. */
  async function hold(what, over) {
    waits.push(what);
    state.waiting = waits[0];
    try {
      await over;
    } finally {
      waits.splice(waits.indexOf(what), 1);
      state.waiting = waits[0] ?? null;
    }
  }

  /** `ms` gone by, or the lane told to stop. */
  function rest(ms) {
    return new Promise((resolve) => {
      if (ending()) return resolve();
      const timer = setTimeout(end, ms);
      function end() {
        clearTimeout(timer);
        resting.delete(end);
        resolve();
      }
      resting.add(end);
    });
  }

  async function rideOut(what, error, works) {
    let outage = false;
    let why = error.message;
    while (!ending()) {
      const ms = delay(++failures);
      await hold({ for: what, why, until: new Date(Date.now() + ms).toISOString() }, rest(ms));
      if (ending()) break;
      try {
        await works();
        break;
      } catch (again) {
        outage = true;
        why = again.message;
      }
    }
    return outage;
  }

  return {
    state,
    ending,
    hold,
    get signal() {
      return cut.signal;
    },

    /** Runs `work` as the lane. Never rejects. */
    async run(work) {
      Object.assign(state, blank(), { on: true, mode: "on" });
      cut = new AbortController();
      failures = 0;
      failing.clear();
      passed.clear();
      try {
        await work();
      } catch (error) {
        if (!cut.signal.aborted) state.error = error.message;
      }
      if (!state.error) state.finished = ending() ? "stopped" : "done";
      Object.assign(state, { on: false, mode: "off", waiting: null });
    },

    /** Told once, it sees through what's in flight; told again, or `now`, it cuts that. */
    stop(now = false) {
      if (!state.on) return;
      if (now || ending()) {
        state.mode = "stopping";
        cut.abort();
      } else state.mode = "finishing";
      for (const wake of [...resting]) wake();
    },

    /** Something went right: the next wait is a short one again. */
    fine() {
      failures = 0;
    },

    /**
     * Waits until `works()` goes through, longer between tries each time: one wait for the whole lane, whoever asks. Says
     * whether there was an outage, `works` having failed meanwhile, or it was only whatever was being tried.
     */
    recover(what, error, works) {
      recovering ??= rideOut(what, error, works).finally(() => {
        recovering = null;
      });
      return recovering;
    },
    /** Settles once the lane isn't waiting anything out. */
    recovered: async () => {
      await recovering;
    },

    /** A clip failed: it's tried again in a while (or `soon`), or passed over once it's had its tries. */
    failed(clip, error, { soon = false } = {}) {
      const tries = (failing.get(clip.name)?.tries ?? 0) + 1;
      if (tries < retry.tries && !error.final) {
        failing.set(clip.name, { tries, until: soon ? 0 : Date.now() + delay(tries) });
        return;
      }
      passed.add(clip.name);
      state.skipped.push({ name: clip.name, why: error.message });
      log(`${clip.name} passed over: ${error.message}`);
    },
    passes: (clip) => passed.has(clip.name),
    /** How long until a clip that failed is tried again: 0 for one that may go now. */
    wait: (clip) => Math.max(0, (failing.get(clip.name)?.until ?? 0) - Date.now()),
  };
}
