import { expect, test } from "bun:test";
import { HELD, pauseFlag } from "./pause.mjs";

/** A flag on a clock of its own, against a site whose answer is `site.paused`. */
function harness() {
  const site = { paused: null, asked: 0, down: false, unpaired: false };
  const clock = { now: 1_000_000 };
  const heard = [];
  const logged = [];
  const flag = pauseFlag({
    ask: async () => {
      site.asked++;
      if (site.down) throw new Error("fetch failed");
      return site.unpaired ? null : { watching: false, paused: site.paused };
    },
    clock: () => clock.now,
    changed: (held) => heard.push(held),
    log: (line) => logged.push(line),
  });
  return { site, clock, heard, logged, flag };
}

test("asks at once, then every 30 seconds, and says why everything waits while it's paused", async () => {
  const { site, clock, heard, flag } = harness();
  await flag.check();
  expect(flag.held()).toBeNull();
  site.paused = { since: 42 };
  clock.now += 29_000;
  await flag.check();
  expect(site.asked).toBe(1);
  clock.now += 1_000;
  await flag.check();
  expect(site.asked).toBe(2);
  expect(flag.held()).toBe(HELD);
  expect(flag.since).toBe(42);
  site.paused = null;
  clock.now += 30_000;
  await flag.check();
  expect(flag.held()).toBeNull();
  expect(heard).toEqual([true, false]);
});

test("an answer to a report counts as asking: nothing more is asked for 30 seconds", async () => {
  const { site, clock, heard, flag } = harness();
  flag.learn({ since: 7 });
  expect(flag.held()).toBe(HELD);
  clock.now += 20_000;
  await flag.check();
  expect(site.asked).toBe(0);
  // Told the same again, nothing's heard to change.
  flag.learn({ since: 7 });
  flag.learn(null);
  expect(heard).toEqual([true, false]);
});

test("unpaired, or with the site down, it stays as it was and asks again in 30 seconds, saying so once", async () => {
  const { site, clock, flag, logged } = harness();
  flag.learn({ since: 7 });
  clock.now += 30_000;
  site.down = true;
  await flag.check();
  clock.now += 30_000;
  await flag.check();
  expect(flag.held()).toBe(HELD);
  expect(logged.filter((line) => line.includes("fetch failed"))).toHaveLength(1);
  site.down = false;
  site.unpaired = true;
  clock.now += 10_000;
  await flag.check();
  expect(site.asked).toBe(2);
  clock.now += 20_000;
  await flag.check();
  expect(site.asked).toBe(3);
  expect(flag.held()).toBe(HELD);
});
