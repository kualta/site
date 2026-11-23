import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { LaneAsks, MacLane, MacReport } from "@/lib/publisher/mac";
import { laneControl, MacSection, type MacReply, spaceText } from "./PublisherMac";

const now = Date.parse("2026-11-23T12:00:00Z");
const lane = (change: Partial<MacLane> = {}): MacLane => ({
  state: "running",
  speed: 887_500,
  left: 43_620,
  waiting: null,
  error: null,
  ...change,
});
const report = (change: Partial<MacReport> = {}, lanes: Partial<MacReport["lanes"]> = {}): MacReport => ({
  version: 1,
  at: new Date(now - 20_000).toISOString(),
  running: true,
  lanes: {
    copy: lane({ state: "done", speed: null, left: null }),
    send: lane(),
    ...lanes,
  },
  camera: { mounted: true, clips: 98, bytes: 47.6e9, space: { used: 108.7e9, total: 111.86e9 } },
  mac: { clips: 160, bytes: 38.7e9, space: { used: 454e9, total: 494.38e9 } },
  skipped: [{ lane: "send", name: "DJI_20261120183012_0399_D.MP4", why: "doesn't read back" }],
  transcripts: { waiting: 3, failed: 1, toSend: 4, error: "no GPU" },
  kept: { days: ["2026-11-08", "2026-11-15"], clips: 45 },
  heard: { copy: null, send: null },
  ...change,
});
/** What the section says, as text, a slot a line: each lane's state and figures, and the rest. */
function says(
  reply: MacReply | null,
  { age = 20_000, failed = false, trouble = {} }: { age?: number; failed?: boolean; trouble?: object } = {},
) {
  const html = renderToString(
    <MacSection
      reply={reply}
      failed={failed}
      now={now}
      heardAt={reply?.age === null ? null : now - age}
      trouble={trouble}
    />,
  );
  const text = html
    .replace(/<(dd|p|li|h3|span|small|dt|h2|div|button)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
const heard = (r: MacReport | null, age = 20_000, lanes: LaneAsks = {}): MacReply => ({
  age: r ? age : null,
  report: r,
  lanes,
});
/** A switch's lines, from its name to the line under it. */
const laneOf = (lines: string[], name: string, count = 12) =>
  lines.slice(lines.indexOf(name), lines.indexOf(name) + count);

test("each switch says its state, the space where it takes clips from, what's left, and how fast it goes", () => {
  const lines = says(heard(report()));
  expect(lines.slice(0, 2)).toEqual(["This Mac", "Updated just now"]);
  expect(laneOf(lines, "Camera → Mac", 13)).toEqual([
    "Camera → Mac",
    "Done",
    "Start",
    "Camera",
    "109 of 112 GB · 97%",
    "To copy",
    "98 clips",
    "47.6 GB",
    "Speed",
    "—",
    "Time left",
    "—",
    "Mac → Cloudflare",
  ]);
  expect(laneOf(lines, "Mac → Cloudflare", 14)).toEqual([
    "Mac → Cloudflare",
    "Running",
    "Pause",
    "Mac",
    "454 of 494 GB · 92%",
    "To send",
    "160 clips",
    "38.7 GB",
    "Speed",
    "7.1 Mbit/s",
    "Time left",
    "12 h 7 min",
    "Passed over 0399: doesn't read back",
    "Kept",
  ]);
  expect(lines.slice(lines.indexOf("Kept"))).toEqual([
    "Kept",
    "2 days",
    "45 clips",
    "Transcripts",
    "3 waiting",
    "4 to send · 1 failed: no GPU",
  ]);
  // Nothing in it counts from when a run started.
  for (const gone of ["this run", "Freed from the card", "Room on the Mac", "Offloading since"])
    expect(lines.some((line) => line.includes(gone))).toBe(false);
});

test("a volume's space: tenths below 100 GB, whole above, and full only when it is", () => {
  expect(spaceText({ used: 47.64e9, total: 64e9 })).toBe("47.6 of 64.0 GB · 74%");
  expect(spaceText({ used: 237.9e9, total: 238e9 })).toBe("238 of 238 GB · 99%");
  expect(spaceText({ used: 238e9, total: 238e9 })).toBe("238 of 238 GB · 100%");
});

test("an unplugged camera, and a Mac or switch with nothing left, say so without zeros", () => {
  const idle = lane({ state: "idle", speed: null, left: null });
  const lines = says(
    heard(
      report(
        {
          running: false,
          camera: { mounted: false, clips: 0, bytes: 0, space: null },
          mac: { clips: 0, bytes: 0, space: { used: 300e9, total: 494.38e9 } },
          skipped: [],
          kept: { days: [], clips: 0 },
          transcripts: { waiting: 0, failed: 0, toSend: 0, error: null },
        },
        { copy: idle, send: idle },
      ),
    ),
  );
  expect(laneOf(lines, "Camera → Mac", 7)).toEqual([
    "Camera → Mac",
    "Paused",
    "Start",
    "Camera",
    "Not plugged in",
    "To copy",
    "—",
  ]);
  expect(laneOf(lines, "Mac → Cloudflare", 7).slice(5)).toEqual(["To send", "None"]);
  expect(lines.slice(lines.indexOf("Kept"))).toEqual(["Kept", "None", "Transcripts", "0 waiting"]);
});

test("waiting, held, pausing and failed switches say why", () => {
  const until = new Date(now + 4 * 60_000).toISOString();
  const lines = says(
    heard(
      report(
        {},
        {
          copy: lane({ state: "waiting", speed: null, left: null, waiting: { for: "camera", why: "x", until } }),
          send: lane({
            state: "paused",
            speed: null,
            left: null,
            waiting: { for: "page", why: "No Grade page is open", until: null },
          }),
        },
      ),
    ),
  );
  expect(lines.find((line) => line.startsWith("Waiting for the camera, tries again "))).toBeTruthy();
  expect(laneOf(lines, "Mac → Cloudflare", 3)).toEqual(["Mac → Cloudflare", "Held", "Pause"]);
  expect(lines).toContain("Held until a Grade page is open");
  const network = says(
    heard(report({}, { send: lane({ state: "waiting", waiting: { for: "network", why: "fetch failed", until } }) })),
  );
  expect(network.find((line) => line.startsWith("Can't reach Cloudflare, tries again "))).toBeTruthy();
  const stopping = says(heard(report({}, { send: lane({ state: "stopping" }) })));
  expect(laneOf(stopping, "Mac → Cloudflare", 3)).toEqual(["Mac → Cloudflare", "Pausing", "Start"]);
  expect(stopping).toContain("After the clips in flight");
  const failed = says(heard(report({ running: false }, { send: lane({ state: "failed", error: "Pair again" }) })));
  expect(laneOf(failed, "Mac → Cloudflare", 3)).toEqual(["Mac → Cloudflare", "Failed", "Start"]);
  expect(failed).toContain("Pair again");
});

test("Pause all holds a switch that's on, which says so, and its button still pauses it", () => {
  const owner = { for: "owner", why: "Paused from the Footage tab", until: null };
  const held = says(heard(report({}, { send: lane({ state: "paused", speed: null, left: null, waiting: owner }) })));
  expect(laneOf(held, "Mac → Cloudflare", 3)).toEqual(["Mac → Cloudflare", "Held", "Pause"]);
  expect(held).toContain("Held by Pause all");
  // Paused while held, it stops once everything goes on and the clips in flight are up.
  const stopping = says(heard(report({}, { send: lane({ state: "stopping", waiting: owner }) })));
  expect(stopping).toContain("After the clips in flight, once you resume all");
});

test("a Start or Pause on its way says so until the Mac has taken it, and can be taken back", () => {
  const off = lane({ state: "stopped", speed: null, left: null });
  // Asked to start, not yet heard: starting, and the button takes it back.
  expect(laneControl(off, { want: "start", at: 5 }, null)).toEqual({
    state: "Starting…",
    next: "pause",
    asked: "start",
  });
  // Heard: as the Mac says.
  expect(laneControl(lane(), { want: "start", at: 5 }, { at: 5, error: null })).toEqual({
    state: "Running",
    next: "pause",
    asked: null,
  });
  expect(laneControl(lane(), { want: "pause", at: 9 }, { at: 5, error: null })).toEqual({
    state: "Pausing…",
    next: "start",
    asked: "pause",
  });
  // Already as asked, it shows as it is.
  expect(laneControl(off, { want: "pause", at: 9 }, { at: 5, error: null })).toMatchObject({ state: "Paused" });
  // Started while it's still pausing: it starts once it has.
  expect(laneControl(lane({ state: "stopping" }), { want: "start", at: 9 }, { at: 5, error: null })).toMatchObject({
    state: "Starting…",
    next: "pause",
  });
  // In the section: starting until it's heard, and one the Mac couldn't do says why, while it's the last asked.
  const asked = says(heard(report({}, { copy: off }), 20_000, { copy: { want: "start", at: 7 } }));
  expect(laneOf(asked, "Camera → Mac", 3)).toEqual(["Camera → Mac", "Starting…", "Pause"]);
  const why = says(
    heard(
      report({ heard: { copy: { at: 7, error: "Pair the crossposter helper first" }, send: null } }, { copy: off }),
      20_000,
      {
        copy: { want: "start", at: 7 },
      },
    ),
  );
  expect(why).toContain("Couldn't start: Pair the crossposter helper first");
  // And a request the site refused says why too.
  expect(says(heard(report()), { trouble: { send: "Couldn't ask: Owner sign-in required" } })).toContain(
    "Couldn't ask: Owner sign-in required",
  );
});

test("a run whose Mac has gone quiet reads as stale; an idle Mac's numbers simply say when", () => {
  const stale = says(heard(report(), 25 * 60_000), { age: 25 * 60_000 });
  expect(stale[1]).toBe("Not heard from for 25 min");
  const html = renderToString(<MacSection reply={heard(report(), 1)} now={now} heardAt={now - 25 * 60_000} />);
  expect(html).toContain('data-stale="true"');
  expect(html).toContain('data-tone="bad"');
  // Not running, the same age is only how old its numbers are.
  const idle = says(heard(report({ running: false }), 3 * 3_600_000), { age: 3 * 3_600_000 });
  expect(idle[1]).toBe("Updated 3 h ago");
});

test("before the Mac has said anything, and before the tab has heard, every slot holds a dash", () => {
  const none = says(heard(null));
  expect(none[1]).toBe("No report from the Mac yet");
  // Each switch's space and three figures, and the two under them.
  expect(none.filter((line) => line === "—").length).toBe(2 * 4 + 2 + 2);
  expect(renderToString(<MacSection reply={heard(null)} now={now} />).match(/disabled=""/g)).toHaveLength(2);
  expect(says(null)[1]).toBe("Reading…");
  expect(says(null, { failed: true })[1]).toBe("Couldn't load. Retrying…");
  // The same slots, whatever it holds.
  const slots = (reply: MacReply | null) =>
    renderToString(<MacSection reply={reply} now={now} heardAt={null} />).match(/<(dd|dt|li|p|h3|small|button|span)\b/g)
      ?.length;
  expect(slots(null)).toBe(slots(heard(report({ skipped: [] }))));
});

test("a report kept from before the grade app said its space and what it's heard still reads", () => {
  const { heard: _, ...older } = report();
  const old = {
    ...older,
    camera: { mounted: true, clips: 98, bytes: 47.6e9 },
    mac: { clips: 160, bytes: 38.7e9 },
  } as unknown as MacReport;
  const lines = says(heard(old, 20_000, { send: { want: "pause", at: 3 } }));
  expect(laneOf(lines, "Camera → Mac", 5).slice(3)).toEqual(["Camera", "—"]);
  expect(laneOf(lines, "Mac → Cloudflare", 3)).toEqual(["Mac → Cloudflare", "Pausing…", "Start"]);
});
