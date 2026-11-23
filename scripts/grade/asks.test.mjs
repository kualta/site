import { expect, test } from "bun:test";
import { laneAsks } from "./asks.mjs";

/** The asks against switches that only note what they're told, and a store that keeps what's been done. */
function harness({ kept = {}, apply } = {}) {
  const store = { done: kept, writes: 0 };
  const did = [];
  const changed = [];
  const logged = [];
  const asks = laneAsks({
    store: {
      read: async () => store.done,
      write: async (done) => {
        store.writes++;
        store.done = done;
      },
    },
    apply:
      apply ??
      (async (lane, want) => {
        did.push(`${want} ${lane}`);
        return true;
      }),
    changed: () => changed.push(true),
    log: (line) => logged.push(line),
  });
  return { asks, store, did, changed, logged };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("does each ask once, by when it was asked, and keeps what it's done", async () => {
  const { asks, store, did, changed } = harness();
  // Heard before it starts, it waits for the app to be up.
  asks.learn({ copy: { want: "start", at: 10 } });
  await settle();
  expect(did).toEqual([]);
  await asks.start();
  expect(did).toEqual(["start copy"]);
  expect(store.done).toEqual({ copy: { at: 10, error: null } });
  expect(changed).toHaveLength(1);
  // The same asks again, as every answer says them, do nothing more.
  asks.learn({ copy: { want: "start", at: 10 } });
  await settle();
  expect(did).toEqual(["start copy"]);
  // A later one is done, each switch by itself.
  asks.learn({ copy: { want: "pause", at: 20 }, send: { want: "start", at: 15 } });
  await settle();
  expect(did).toEqual(["start copy", "pause copy", "start send"]);
  expect(asks.heard()).toEqual({ copy: { at: 20, error: null }, send: { at: 15, error: null } });
});

test("after a restart nothing done is done again, and what was asked meanwhile is", async () => {
  const { asks, did } = harness({ kept: { copy: { at: 20, error: null }, send: { at: 15, error: null } } });
  asks.learn({ copy: { want: "pause", at: 20 }, send: { want: "pause", at: 30 } });
  await asks.start();
  expect(did).toEqual(["pause send"]);
});

test("one that can't be done yet is tried at the next answer; one that can't be done at all says why", async () => {
  const world = { ready: false };
  const tried = [];
  const { asks, store, logged } = harness({
    apply: async (lane, want) => {
      tried.push(`${want} ${lane}`);
      if (lane === "send") throw new Error("Pair the crossposter helper first");
      return world.ready;
    },
  });
  await asks.start();
  asks.learn({ copy: { want: "start", at: 5 }, send: { want: "start", at: 6 } });
  await settle();
  expect(store.done).toEqual({ send: { at: 6, error: "Pair the crossposter helper first" } });
  expect(logged).toEqual(["couldn't start send: Pair the crossposter helper first"]);
  world.ready = true;
  asks.learn({ copy: { want: "start", at: 5 }, send: { want: "start", at: 6 } });
  await settle();
  expect(tried).toEqual(["start copy", "start send", "start copy"]);
  expect(asks.heard().copy).toEqual({ at: 5, error: null });
});

test("what isn't an ask is passed over, and an answer without asks changes nothing", async () => {
  const { asks, did } = harness();
  await asks.start();
  asks.learn(undefined);
  asks.learn({ copy: { want: "stop", at: 5 }, send: { want: "start", at: "soon" }, exports: { want: "start", at: 5 } });
  await settle();
  expect(did).toEqual([]);
});

test("asks heard while one is being done are done after it, in turn", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const did = [];
  const { asks } = harness({
    apply: async (lane, want) => {
      did.push(`${want} ${lane}`);
      if (did.length === 1) await gate;
      return true;
    },
  });
  await asks.start();
  asks.learn({ send: { want: "start", at: 1 } });
  asks.learn({ send: { want: "pause", at: 2 } });
  await settle();
  expect(did).toEqual(["start send"]);
  release();
  await settle();
  await settle();
  expect(did).toEqual(["start send", "pause send"]);
});
