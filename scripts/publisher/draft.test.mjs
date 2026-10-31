import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft } from "./draft.mjs";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const text = { title: "A film", caption: "About films", alt: "", zh: { title: "短片", text: "短片。", topics: [] } };
let dir;
let clip;
let long;
const makeClip = (name, args) => {
  const file = join(dir, name);
  execFileSync(ffmpeg, ["-y", "-f", "lavfi", ...args, file], { stdio: "ignore" });
  return file;
};
const spec = (fields) => {
  const file = join(dir, `spec-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(fields));
  return file;
};
/** Records requests and answers like the Worker's helper routes. */
function worker(reject) {
  const calls = [];
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname.replace("/api/publisher/helper/", "");
    calls.push({ path, init });
    if (reject && path === "drafts/check") return Response.json({ error: reject }, { status: 400 });
    if (path === "media") return Response.json({ id: "media-id" });
    if (path === "drafts") return Response.json({ id: "draft-id" }, { status: 201 });
    return Response.json({ ok: true });
  };
  return { calls, fetcher };
}
const options = (fetcher, extra = {}) => ({ origin: "https://post.kualta.dev", token: "secret", fetcher, ...extra });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "publisher-draft-test-"));
  clip = makeClip("clip.mp4", ["-i", "color=c=gray:s=160x90:r=5:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
  long = makeClip("long.mp4", ["-i", "color=c=gray:s=160x90:r=1:d=181", "-c:v", "libx264", "-pix_fmt", "yuv420p"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("createDraft", () => {
  test("checks the text, uploads the video with the pairing key, and returns the page to publish from", async () => {
    const { calls, fetcher } = worker();
    const specFile = spec({ video: "clip.mp4", ...text });
    expect(await createDraft(specFile, options(fetcher))).toEqual({
      id: "draft-id",
      url: "https://post.kualta.dev/?draft=draft-id",
      reencoded: false,
    });
    expect(calls.map((call) => call.path)).toEqual(["drafts/check", "media", "drafts"]);
    expect(calls.every((call) => call.init.headers.Authorization === "Bearer secret")).toBe(true);
    expect(calls[1].init.headers["Content-Type"]).toBe("video/mp4");
    expect(calls[1].init.body.length).toBe(statSync(clip).size);
    const draft = JSON.parse(calls[2].init.body);
    expect(draft).toEqual({ preset: "short", ...text, video: "media-id" });
  });

  test("never touches anything that publishes", async () => {
    const { calls, fetcher } = worker();
    await createDraft(spec({ video: clip, ...text }), options(fetcher));
    expect(calls.some((call) => call.path.includes("jobs") || call.path.includes("crosspost"))).toBe(false);
  });

  test("uploads nothing when the text would be rejected, and says why", async () => {
    const { calls, fetcher } = worker("Bluesky: text is 350/300");
    await expect(createDraft(spec({ video: clip, ...text }), options(fetcher))).rejects.toThrow(
      "Bluesky: text is 350/300",
    );
    expect(calls.map((call) => call.path)).toEqual(["drafts/check"]);
  });

  test("films past three minutes open under Long video unless the spec names a preset", async () => {
    const { calls, fetcher } = worker();
    await createDraft(spec({ video: long, ...text }), options(fetcher));
    expect(JSON.parse(calls.at(-1).init.body).preset).toBe("video");
    const named = worker();
    await createDraft(spec({ video: long, preset: "my-preset", ...text }), options(named.fetcher));
    expect(JSON.parse(named.calls.at(-1).init.body).preset).toBe("my-preset");
  });

  test("re-encodes a video over the upload limit to fit", async () => {
    // Long enough for x264's rate control to settle, as it does on any film large enough to need this.
    const big = makeClip("big.mov", ["-i", "testsrc2=s=320x180:r=30:d=20,noise=alls=12:allf=t", "-c:v", "libx264", "-crf", "10", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);
    const maxBytes = 3_000_000;
    expect(statSync(big).size).toBeGreaterThan(maxBytes);
    const { calls, fetcher } = worker();
    const { reencoded } = await createDraft(spec({ video: big, ...text }), options(fetcher, { maxBytes }));
    const upload = calls.find((call) => call.path === "media");
    expect(reencoded).toBe(true);
    expect(upload.init.body.length).toBeLessThanOrEqual(maxBytes);
    expect(upload.init.headers["Content-Type"]).toBe("video/mp4");
    const written = join(dir, "uploaded.mp4");
    writeFileSync(written, upload.init.body);
    const shape = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width", "-of", "csv=p=0", written]);
    expect(String(shape)).toContain("h264,320");
  });

  test("won't crush a long video into the upload limit", async () => {
    const { calls, fetcher } = worker();
    await expect(createDraft(spec({ video: long, ...text }), options(fetcher, { maxBytes: 100 }))).rejects.toThrow(
      "watchable quality",
    );
    expect(calls.map((call) => call.path)).toEqual(["drafts/check"]);
  });

  test("names what's wrong with the spec", async () => {
    const { fetcher } = worker();
    await expect(createDraft(spec({ ...text }), options(fetcher))).rejects.toThrow('needs a "video" path');
    await expect(createDraft(spec({ video: "a.gif", ...text }), options(fetcher))).rejects.toThrow("MP4, MOV or WebM");
  });
});
