import { expect, test } from "bun:test";
import { offloadLine } from "./offload.mjs";

const lane = (change = {}) => ({
  on: true,
  mode: "on",
  total: 167,
  bytes: 40.1e9,
  done: 7,
  doneBytes: 1.3e9,
  current: [],
  waiting: null,
  skipped: [],
  ...change,
});
const off = lane({ on: false, mode: "off", total: 0, bytes: 0, done: 0, doneBytes: 0 });
const run = (change = {}) => ({
  running: true,
  speed: 887_500,
  sentBytes: 1.4e9,
  error: null,
  transcripts: { sent: 0, error: null },
  copy: { ...off, current: null, onCamera: 0 },
  send: lane(),
  ...change,
});

test("the status line says the offload in a few words: clips through of how many, and the time left", () => {
  expect(offloadLine(null)).toBe("");
  expect(offloadLine(run())).toBe("Offloading 7 / 167 · 12.1 h left");
  expect(offloadLine(run({ speed: null }))).toBe("Offloading 7 / 167");
  // Copying alone, it counts the card's clips; there's no speed to go by.
  expect(offloadLine(run({ send: off, copy: { ...lane({ done: 3, total: 12 }), current: null, onCamera: 0 } }))).toBe(
    "Offloading 3 / 12",
  );
});

test("held up, it says what by instead of the time left", () => {
  const until = new Date().toISOString();
  const held = (waiting) => offloadLine(run({ send: lane({ waiting }) }));
  expect(held({ for: "page", why: "No Grade page is open" })).toBe("Offloading 7 / 167 · paused");
  expect(held({ for: "owner", why: "Paused from the Footage tab" })).toBe("Offloading 7 / 167 · paused");
  expect(held({ for: "network", why: "fetch failed", until })).toBe("Offloading 7 / 167 · can't reach the cloud");
  expect(held({ for: "trouble", why: "x", until })).toBe("Offloading 7 / 167 · waiting");
  expect(offloadLine(run({ send: lane({ mode: "finishing" }) }))).toBe("Offloading 7 / 167 · stopping");
  const copying = (waiting) =>
    offloadLine(run({ send: off, copy: { ...lane({ waiting }), current: null, onCamera: 0 } }));
  expect(copying({ for: "camera", why: "The camera isn't plugged in", until })).toBe(
    "Offloading 7 / 167 · waiting for the camera",
  );
  expect(copying({ for: "room", why: "No room" })).toBe("Offloading 7 / 167 · waiting for room");
});

test("after a run it says what went wrong, if anything did", () => {
  expect(offloadLine(run({ running: false }))).toBe("");
  expect(offloadLine(run({ running: false, error: "The camera was unplugged" }))).toBe(
    "Offload stopped: The camera was unplugged",
  );
  const passed = run({
    running: false,
    send: lane({ on: false, skipped: [{ name: "DJI_1.MP4", why: "doesn't read back" }] }),
  });
  expect(offloadLine(passed)).toBe("Offload: 1 clip passed over, DJI_1.MP4: doesn't read back");
  expect(offloadLine(run({ running: false, transcripts: { error: "no GPU" } }))).toBe("Transcripts not sent: no GPU");
});
