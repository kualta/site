import { expect, test } from "bun:test";
import { failedText } from "./PublisherFootage";

const clip = {
  name: "DJI_20261121101500_0402_D.mp4",
  title: "2026-11-21 10:15:00 · clip 0402",
  size: 1,
  from: "exported" as const,
  state: "due" as const,
  video: null,
  uploadedAt: null,
};
const at = new Date();
at.setHours(12, 12, 0, 0);
const pausedUntil = at.getTime() + 30 * 60_000;
const failed = (message: string, name = clip.name, when = at.toISOString()) =>
  failedText({ lastError: { clip: name, message, at: when }, pausedUntil, clips: [clip] });

test("an upload cut off says the connection dropped, which clip, when, and when it's tried again", () => {
  for (const message of [
    "terminated",
    "read ECONNRESET",
    "connect ETIMEDOUT 142.250.0.1:443",
    "fetch failed",
    "socket hang up",
  ])
    expect(failed(message)).toMatch(
      /^Upload of 2026-11-21 10:15:00 · clip 0402 cut off at .*12:12.*: the connection dropped; trying again at .*12:42/,
    );
});

test("any other failure is said as it is, and a clip the status doesn't list goes by its name", () => {
  expect(failed("YouTube refused part of the upload (503)")).toMatch(
    /^Upload of 2026-11-21 10:15:00 · clip 0402 failed at .*12:12.*: YouTube refused part of the upload \(503\); trying again at .*12:42/,
  );
  // Its own full stop gives way to the next clause.
  expect(failed("YouTube says the channel reached its daily upload limit.", "DJI_0001.mp4", "")).toMatch(
    /^Upload of DJI_0001\.mp4 failed: YouTube says the channel reached its daily upload limit; trying again at /,
  );
  // "terminated" inside another word isn't the network's.
  expect(failed("the session was predetermined")).toContain("failed at");
  expect(failedText({ lastError: null, pausedUntil, clips: [] })).toMatch(/^Paused: trying again at .*12:42/);
});
