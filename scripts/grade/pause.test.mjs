import { expect, test } from "bun:test";
import { HELD, pauseFlag } from "./pause.mjs";

/** A flag on a clock of its own, against a site whose answer is `site.paused`, and whether the tab is open. */
function harness() {
  const site = { paused: null, watching: false, asked: 0, down: false, unpaired: false };
  const clock = { now: 1_000_000 };
  const heard = [];
  const logged = [];
  const flag = pauseFlag({
    ask: async () => {
      site.asked++;
      if (site.down) throw new Error("fetch failed");
      return site.unpaired ? null : { watching: site.watching, paused: site.paused };
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

test("while the Footage tab is open it's asked every 4 seconds, so a Start or Pause there is heard within seconds", async () => {
  const { site, clock, flag } = harness();
  await flag.check();
  expect(flag.watched).toBe(false);
  // The tab opens: heard at the next asking, and from then on asked every 4 seconds.
  site.watching = true;
  clock.now += 30_000;
  await flag.check();
  expect(flag.watched).toBe(true);
  const asked = site.asked;
  for (let s = 1; s <= 12; s++) {
    clock.now += 1_000;
    await flag.check();
  }
  expect(site.asked - asked).toBe(3);
  // An answer to a report counts as asking, and says it too.
  flag.learn(null, true);
  clock.now += 3_000;
  await flag.check();
  expect(site.asked - asked).toBe(3);
  // Closed, every 30 seconds again; an answer that doesn't say leaves it as it was.
  flag.learn(null, false);
  flag.learn(null);
  expect(flag.watched).toBe(false);
  clock.now += 29_000;
  await flag.check();
  expect(site.asked - asked).toBe(3);
});

test("the site down is said once, and its coming back once", async () => {
  const { site, clock, flag, logged } = harness();
  site.down = true;
  for (let n = 0; n < 3; n++) {
    await flag.check();
    clock.now += 30_000;
  }
  site.down = false;
  await flag.check();
  clock.now += 30_000;
  await flag.check();
  expect(logged).toEqual(["couldn't ask the site: fetch failed", "reaching the site again"]);
});
