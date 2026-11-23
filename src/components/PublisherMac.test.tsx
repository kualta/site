import { expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import type { MacLane, MacReport, Paused } from "@/lib/publisher/mac";
import { MacSection, type MacReply } from "./PublisherMac";

const now = Date.parse("2026-11-23T12:00:00Z");
const lane = (change: Partial<MacLane> = {}): MacLane => ({
  state: "running",
  done: 7,
  total: 167,
  sentBytes: 1.4e9,
  totalBytes: 40.1e9,
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
  startedAt: new Date(now - 3_600_000).toISOString(),
  endedAt: null,
  lanes: {
    copy: lane({ state: "done", done: 167, sentBytes: 40.1e9, speed: null, left: null }),
    send: lane(),
    ...lanes,
  },
  camera: { mounted: true, clips: 0, bytes: 0 },
  mac: { clips: 160, bytes: 38.7e9 },
  freed: { camera: 40.1e9, mac: 1.4e9 },
  skipped: [{ lane: "send", name: "DJI_20261120183012_0399_D.MP4", why: "doesn't read back" }],
  transcripts: { made: 12, waiting: 3, failed: 1, toSend: 4, error: null },
  kept: { days: ["2026-11-08", "2026-11-15"], clips: 45 },
  room: { free: 123e9, keepFree: 5e9 },
  ...change,
});
/** What the section says, as text, a slot a line: each lane's state and figures, and the rest. */
function says(
  reply: MacReply | null,
  { age = 20_000, failed = false, paused = null }: { age?: number; failed?: boolean; paused?: Paused | null } = {},
) {
  const html = renderToString(
    <MacSection
      reply={reply}
      failed={failed}
      now={now}
      heardAt={reply?.age === null ? null : now - age}
      paused={paused}
    />,
  );
  const text = html
    .replace(/<(dd|p|li|h3|span|small|dt|h2|div)[^>]*>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
const heard = (r: MacReport | null, age = 20_000): MacReply => ({ age: r ? age : null, report: r });

test("a run going: each switch's numbers, and the rest, each in its place", () => {
  const lines = says(heard(report()));
  expect(lines.slice(0, 3)).toEqual(["This Mac", "Updated just now", expect.stringMatching(/^Offloading since /)]);
  const copy = lines.indexOf("Camera → Mac");
  expect(lines.slice(copy, copy + 11)).toEqual([
    "Camera → Mac",
    "Done",
    "Clips",
    "167 / 167",
    "Size",
    "40.1 / 40.1 GB",
    "Speed",
    "—",
    "Time left",
    "—",
    "All copied: unplug the camera whenever",
  ]);
  const send = lines.indexOf("Mac → Cloudflare");
  expect(lines.slice(send, send + 11)).toEqual([
    "Mac → Cloudflare",
    "Running",
    "Clips",
    "7 / 167",
    "Size",
    "1.4 / 40.1 GB",
    "Speed",
    "7.1 Mbit/s",
    "Time left",
    "12 h 7 min",
    "Sending, 160 to go",
  ]);
  const rest = lines.slice(lines.indexOf("Transcripts"));
  expect(rest).toEqual([
    "Transcripts",
    "12 made",
    "3 waiting · 1 failed",
    "Freed from the card",
    "40.1 GB",
    "this run",
    "Freed from the Mac",
    "1.4 GB",
    "this run",
    "Room on the Mac",
    "123 GB",
    "5 GB kept free",
    "Kept",
    "2 days",
    "45 clips",
    "Passed over",
    "1",
    "DJI_20261120183012_0399_D.MP4 doesn't read back",
  ]);
});

test("waiting, paused, stopping and failed switches say why", () => {
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
  expect(lines).toContain("Waiting");
  expect(lines.find((line) => line.startsWith("Waiting for the camera, tries again "))).toBeTruthy();
  expect(lines).toContain("Paused");
  expect(lines).toContain("Paused while no Grade page is open");
  const network = says(
    heard(
      report(
        {},
        {
          send: lane({
            state: "waiting",
            speed: null,
            left: null,
            waiting: { for: "network", why: "fetch failed", until },
          }),
        },
      ),
    ),
  );
  expect(network.find((line) => line.startsWith("Can't reach Cloudflare, tries again "))).toBeTruthy();
  expect(says(heard(report({}, { send: lane({ state: "stopping" }) })))).toContain(
    "Stopping once what's in flight is done",
  );
  const failed = says(
    heard(
      report(
        { running: false, endedAt: new Date(now).toISOString() },
        { send: lane({ state: "failed", speed: null, left: null, error: "Pair again" }) },
      ),
    ),
  );
  expect(failed).toContain("Failed");
  expect(failed).toContain("Pair again");
  expect(failed.find((line) => line.startsWith("Last offload "))).toBeTruthy();
  expect(failed).toContain("last run");
});

test("a run whose Mac has gone quiet reads as stale; an idle Mac's numbers simply say when", () => {
  const stale = says(heard(report(), 25 * 60_000), { age: 25 * 60_000 });
  expect(stale).toContain("Updated 25 min ago");
  expect(stale).toContain("Not heard from the Mac for 25 min: it may be asleep or off.");
  const html = renderToString(<MacSection reply={heard(report(), 1)} now={now} heardAt={now - 25 * 60_000} />);
  expect(html).toContain('data-stale="true"');
  // Not running, the same age is only how old its numbers are.
  const idle = says(heard(report({ running: false, startedAt: null }), 3 * 3_600_000), { age: 3 * 3_600_000 });
  expect(idle).toContain("Updated 3 h ago");
  expect(idle).toContain("Not offloading");
  const done = says(heard(report({ running: false, endedAt: new Date(now - 60_000).toISOString() })));
  expect(done.find((line) => line.startsWith("Last offload "))).toBeTruthy();
});

test("before the Mac has said anything, and before the tab has heard, every slot holds a dash", () => {
  const none = says(heard(null));
  expect(none).toContain("Nothing from the grade app yet: it reports here once it's running on the Mac, paired.");
  // Each switch's state and four figures, the five under them, and the clips passed over.
  expect(none.filter((line) => line === "—").length).toBe(2 * 5 + 5 + 1);
  expect(says(null)).toContain("Reading…");
  expect(says(null, { failed: true })).toContain("Couldn't load. Retrying…");
  // The same slots, whatever it holds.
  const slots = (reply: MacReply | null) =>
    renderToString(<MacSection reply={reply} now={now} heardAt={null} />).match(/<(dd|dt|li|p|h3|small)\b/g)?.length;
  expect(slots(null)).toBe(slots(heard(report({ skipped: [] }))));
});

test("paused from the Footage tab, it says so and since when, and each switch holds at its numbers", () => {
  const since = new Date(now - 3_600_000).setHours(10, 42, 0, 0);
  const owner = { for: "owner", why: "Paused from the Footage tab", until: null };
  const lines = says(heard(report({}, { send: lane({ state: "paused", speed: null, left: null, waiting: owner }) })), {
    paused: { since },
  });
  expect(lines[2]).toMatch(/^Paused by you · since .*10:42/);
  const send = lines.indexOf("Mac → Cloudflare");
  expect(lines.slice(send, send + 4)).toEqual(["Mac → Cloudflare", "Paused", "Clips", "7 / 167"]);
  expect(lines).toContain("Paused by you");
  // A Mac gone quiet says that first: what it last said may be old.
  const quiet = says(heard(report(), 25 * 60_000), { age: 25 * 60_000, paused: { since } });
  expect(quiet).toContain("Not heard from the Mac for 25 min: it may be asleep or off.");
});

test("an idle switch counts what waits for it", () => {
  const idle = lane({ state: "idle", done: 0, total: 0, sentBytes: 0, totalBytes: 0, speed: null, left: null });
  const lines = says(
    heard(
      report(
        { running: false, startedAt: null, camera: { mounted: true, clips: 12, bytes: 3.2e9 } },
        { copy: idle, send: idle },
      ),
    ),
  );
  expect(lines).toContain("0 / 12");
  expect(lines).toContain("12 clips · 3.2 GB on the camera");
  expect(lines).toContain("0 / 160");
  expect(lines).toContain("160 clips · 38.7 GB to send");
});
