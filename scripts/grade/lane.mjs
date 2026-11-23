// One of the offload's switches as it goes: on until there's nothing left for it to do, or it's stopped.
//
//   off ── start ──▶ on ── nothing left ──▶ off ("done")
//                    ├── stop ──▶ finishing: what's in flight is seen through and nothing new begun ──▶ off ("stopped")
//                    └── stop again, or now ──▶ stopping: what's in flight is cut ──▶ off ("stopped")
//
// What gets in a lane's way (the camera unplugged, the network down) it waits out, longer each time. A clip that keeps
// failing is passed over, saying why, so one can't hold up the rest. A try this Mac slept through isn't held against
// anything: no request outlasts a sleep.

/** How long a lane waits before its first try again and at most, and how often it tries one clip. */
export const RETRY = { first: 30_000, most: 10 * 60_000, tries: 5 };

/**
 * Notices this Mac sleeping. Node's and Bun's own clocks (`performance.now`, `process.hrtime`, the timers) go on through
 * a sleep on macOS just as the wall clock does, so what tells is this process not having run: it beats every `every`,
 * and a beat more than `gap` late by the wall clock (`now`) was a sleep that long. A try begun at `mark()` was slept
 * through if `since(mark)` is more than 0; for `settle` after a wake the network is given time to come back.
 */
export function sleepWatch({ now = Date.now, every = 1000, gap = 30_000, settle = 10_000 } = {}) {
  let last = now();
  let slept = 0;
  /** The last wake: when, after how long, and whether that's been said. */
  let wake = null;
  function look() {
    const at = now();
    const late = at - last - every;
    last = at;
    if (late > gap) {
      slept += late;
      wake = { at, ms: late, told: false };
    }
  }
  const beat = setInterval(look, every);
  beat.unref?.();
  return {
    mark() {
      look();
      return slept;
    },
    since(mark) {
      look();
      return slept - mark;
    },
    /** How long the network is still given after the last wake. */
    settling() {
      look();
      return wake ? Math.max(0, wake.at + settle - now()) : 0;
    },
    /** How long the Mac slept before it last woke, the first time that's asked. */
    tell() {
      if (!wake || wake.told) return null;
      wake.told = true;
      return wake.ms;
    },
    stop: () => clearInterval(beat),
  };
}
/** A watch that never sees a sleep. */
const AWAKE = { mark: () => 0, since: () => 0, settling: () => 0, tell: () => null };
const lasted = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

/**
 * A lane. `shape` is what its state says beyond every lane's; `log` hears each clip passed over, and each wake a try was
 * slept through at. `sleeps` is a `sleepWatch`.
 */
export function makeLane(shape = {}, { retry = RETRY, log = () => {}, sleeps = AWAKE } = {}) {
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
  /** How many things the lane is at: copying, hashing, sending, reading back or filing. */
  let doing = 0;

  /** Whether a try begun at `from` (a mark) was slept through: it isn't counted, as is said once a wake. */
  function slept(from) {
    if (from === undefined || sleeps.since(from) <= 0) return false;
    const ms = sleeps.tell();
    if (ms) log(`the Mac slept ${lasted(ms)}; not counted`);
    return true;
  }

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

  async function rideOut(what, error, works, from) {
    let outage = false;
    let why = error.message;
    let since = from;
    while (!ending()) {
      // A try slept through makes the wait no longer: it goes again once the network has had a moment.
      const ms = Math.max(slept(since) ? 0 : delay(++failures), sleeps.settling());
      since = sleeps.mark();
      await hold({ for: what, why, until: new Date(Date.now() + ms).toISOString() }, rest(ms));
      if (ending()) break;
      if (sleeps.since(since) > 0) continue;
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
    /** Whether it's at something, and not waiting anything out. */
    get working() {
      return state.on && !state.waiting && doing > 0;
    },
    /** Does `work` as something the lane is at. */
    async at(work) {
      doing++;
      try {
        return await work();
      } finally {
        doing--;
      }
    },
    /** Where a try begins: the `from` that `failed`, `recover` and `slept` take. */
    mark: () => sleeps.mark(),
    slept,

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
     * whether there was an outage, `works` having failed meanwhile, or it was only whatever was being tried. `from` is
     * where the try that failed began.
     */
    recover(what, error, works, from) {
      recovering ??= rideOut(what, error, works, from).finally(() => {
        recovering = null;
      });
      return recovering;
    },
    /** Settles once the lane isn't waiting anything out. */
    recovered: async () => {
      await recovering;
    },

    /**
     * A clip failed, its try begun at `from`: it's tried again in a while (or `soon`), or passed over once it's had its
     * tries. A try slept through isn't one of them, and it goes again as soon as the network's had its moment.
     */
    failed(clip, error, { soon = false, from } = {}) {
      const was = failing.get(clip.name)?.tries ?? 0;
      if (!error.final && slept(from)) {
        failing.set(clip.name, { tries: was, until: 0 });
        return;
      }
      const tries = was + 1;
      if (tries < retry.tries && !error.final) {
        failing.set(clip.name, { tries, until: soon ? 0 : Date.now() + delay(tries) });
        return;
      }
      passed.add(clip.name);
      state.skipped.push({ name: clip.name, why: error.message });
      log(`${clip.name} passed over: ${error.message}`);
    },
    passes: (clip) => passed.has(clip.name),
    /** How long until a clip may be tried: a while for one that failed, and a moment after a wake for any. */
    wait: (clip) => Math.max(0, (failing.get(clip.name)?.until ?? 0) - Date.now(), sleeps.settling()),
  };
}
