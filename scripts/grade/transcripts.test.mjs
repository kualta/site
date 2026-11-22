import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FFMPEG } from "./media.mjs";
import { parseWhisper, toVtt, transcriber } from "./transcripts.mjs";

// The transcriber with a stand-in for uvx: a script that logs its start and end, waits for the file `go`, and writes the
// JSON Whisper would, its words the name of the audio it was given. While `fail` exists it says what that holds instead,
// and exits as if all went well, as Whisper does.
const day = "2026-11-18";
const [A, B, C] = ["0001", "0002", "0003"].map((n) => `DJI_20261118100000_${n}_D.MP4`);
let root;
let at;
const there = (...path) => existsSync(join(root, ...path));
const read = (...path) => readFileSync(join(root, ...path), "utf8");
const lines = (file) => (there(file) ? read(file).trim().split("\n") : []);
const list = (...path) => (there(...path) ? readdirSync(join(root, ...path)).sort() : []);
const open = (file, text = "") => writeFileSync(join(root, file), text);
const close = (file) => rmSync(join(root, file), { force: true });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "transcripts-"));
  writeFileSync(
    join(root, "uvx"),
    `#!/bin/sh
cd "${root}"
echo "$*" >> calls
echo "$HF_HUB_OFFLINE" > offline
command -v ffmpeg > ffmpeg
audio="$5"
name=$(basename "$audio" .m4a)
while [ $# -gt 0 ]; do [ "$1" = --output-dir ] && out="$2"; shift; done
echo "start $name" >> log
while [ ! -e go ]; do [ -e uvx ] || exit 1; sleep 0.02; done
echo "end $name" >> log
if [ -e fail ]; then cat fail; exit 0; fi
if [ -e quiet ]; then echo '{"text": "", "segments": [], "language": "en"}' > "$out/transcript.json"; exit 0; fi
cat > "$out/transcript.json" <<JSON
{"text": " $name NaN", "language": "en", "segments": [
  {"id": 0, "start": 0.0, "end": 2.5, "text": " $name", "avg_logprob": NaN, "compression_ratio": Infinity,
   "words": [{"word": " said", "start": 0.6, "end": 1.0, "probability": 0.9}, {"word": " $name", "start": 1.0, "end": 1.9, "probability": 0.5}]},
  {"id": 1, "start": 2.5, "end": 2.5, "text": "", "words": []}]}
JSON
`,
    { mode: 0o755 },
  );
  at = { records: {}, logs: [], made: 0, busy: false };
  open("go");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A transcriber over the test's folders and records, as a server would start it. */
const start = (extra = {}) =>
  transcriber({
    audio: join(root, "audio"),
    dir: join(root, "kept"),
    scratch: join(root, "scratch"),
    records: {
      read: async () => structuredClone(at.records),
      update: async (change) => change(at.records),
    },
    uvx: join(root, "uvx"),
    busy: () => at.busy,
    pause: 10,
    extract: async (src, dst) => {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, `sound of ${src}`);
      return true;
    },
    log: (line) => at.logs.push(line),
    made: () => at.made++,
    ...extra,
  });
const clip = (name, on = day) => ({ name, day: on, path: `/Original/${name}`, size: 1000 });
async function until(check) {
  const end = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const idle = (t) => until(() => !t.summary().current && !t.summary().waiting);

test("each clip's sound is taken and transcribed one at a time, kept as .vtt and .json, and gone once it is", async () => {
  close("go");
  const t = start();
  for (const name of [A, B, C]) await t.take(clip(name));
  expect(list("audio", day)).toEqual([A, B, C].map((name) => `${name}.m4a`));
  await until(() => lines("log").length === 1);
  // Nothing else starts while the first goes on.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lines("log")).toEqual([`start ${A}`]);
  expect(t.summary()).toEqual({ done: 0, total: 3, current: A, waiting: 2, failed: 0, error: null });
  open("go");
  await idle(t);
  expect(lines("log")).toEqual([A, B, C].flatMap((name) => [`start ${name}`, `end ${name}`]));
  expect(t.summary()).toMatchObject({ done: 3, total: 3, failed: 0 });
  expect(at.made).toBe(3);

  expect(list("kept", day)).toEqual(
    [A, B, C].flatMap((name) => [`${name.slice(0, -4)}.json`, `${name.slice(0, -4)}.vtt`]),
  );
  for (const name of [A, B, C]) {
    const stem = name.slice(0, -4);
    expect(read("kept", day, `${stem}.vtt`)).toBe(`WEBVTT\n\n00:00:00.600 --> 00:00:01.900\n${name}\n`);
    expect(JSON.parse(read("kept", day, `${stem}.json`))).toMatchObject({
      clip: name,
      day,
      model: "mlx-community/whisper-large-v3-turbo",
      language: "en",
      text: ` ${name} NaN`,
      segments: [
        {
          avg_logprob: null,
          compression_ratio: null,
          words: [
            { word: " said", start: 0.6, end: 1.0 },
            { word: ` ${name}`, start: 1.0, end: 1.9 },
          ],
        },
        { text: "" },
      ],
    });
    expect(at.records[`${day}/${name}`]).toMatchObject({ size: 1000, language: "en", words: 2 });
  }
  // The audio goes only once its transcript is kept; nothing is left of Whisper's own folder either.
  expect(list("audio", day)).toEqual([]);
  expect(list("scratch")).toEqual([]);

  // A clip taken again, its transcript here, isn't transcribed again.
  await t.take(clip(A));
  await idle(t);
  expect(lines("log")).toHaveLength(6);
  expect(list("audio", day)).toEqual([]);
});

test("Whisper runs offline by uvx's own path with the settings that don't loop, and finds ffmpeg on launchd's PATH", async () => {
  const { PATH } = process.env;
  process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  try {
    const t = start();
    await t.take(clip(A));
    await idle(t);
  } finally {
    process.env.PATH = PATH;
  }
  const [call] = lines("calls");
  expect(call).toStartWith(`--offline --from mlx-whisper mlx_whisper ${join(root, "audio", day, `${A}.m4a`)} `);
  expect(call).toContain("--model mlx-community/whisper-large-v3-turbo");
  expect(call).toContain("--word-timestamps True");
  expect(call).toContain("--condition-on-previous-text False");
  expect(call).toContain("--hallucination-silence-threshold 2");
  expect(call).not.toContain("--language");
  expect(read("offline").trim()).toBe("1");
  expect(read("ffmpeg").trim()).toBe(FFMPEG);
});

test("none is started while an export runs, and they go on after it", async () => {
  at.busy = true;
  const t = start();
  await t.take(clip(A));
  await t.take(clip(B));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lines("log")).toEqual([]);
  expect(t.summary()).toMatchObject({ current: null, waiting: 2, done: 0, total: 2 });
  at.busy = false;
  await idle(t);
  expect(t.summary()).toMatchObject({ done: 2, total: 2 });
});

test("a Whisper that fails is logged once, keeps the audio, lets the rest go on, and is tried again later", async () => {
  open("fail", "Traceback...\nSkipping /audio/x.m4a due to RuntimeError: Failed to load audio\n");
  let taken = 0;
  const extract = async (_src, dst) => {
    taken++;
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, "sound");
    return true;
  };
  const t = start({ extract });
  for (const name of [A, B]) await t.take(clip(name));
  await idle(t);
  const why = "RuntimeError: Failed to load audio";
  expect(t.summary()).toMatchObject({ failed: 2, error: why, done: 2, total: 2 });
  expect(at.logs).toEqual([`grade: transcripts: ${A}: ${why}`]);
  expect(list("audio", day)).toHaveLength(2);
  expect(list("kept")).toEqual([]);

  // Its clip still on the Mac in the next run: the audio that waits is tried again, not taken again.
  close("fail");
  await t.take(clip(A));
  t.retry();
  await idle(t);
  expect(taken).toBe(2);
  expect(t.summary()).toMatchObject({ failed: 0, error: null });
  expect(list("audio", day)).toEqual([]);
  expect(list("kept", day)).toHaveLength(4);
});

test("a uvx that can't find what it needs offline says so", async () => {
  writeFileSync(
    join(root, "uvx"),
    "#!/bin/sh\necho '  × No solution found when resolving tool dependencies:' >&2\necho 'hint: the network was disabled.' >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const t = start();
  await t.take(clip(A));
  await idle(t);
  expect(t.summary()).toMatchObject({ failed: 1, error: "No solution found when resolving tool dependencies:" });
  expect(list("audio", day)).toHaveLength(1);
});

test("without uvx the audio waits, and it's said once", async () => {
  const t = start({ uvx: join(root, "nowhere/uvx") });
  for (const name of [A, B]) await t.take(clip(name));
  await idle(t);
  expect(t.summary()).toMatchObject({ failed: 2, error: "uvx isn't installed, so Whisper can't run" });
  expect(at.logs).toHaveLength(1);
  expect(list("audio", day)).toHaveLength(2);
  // Once it's there.
  const again = start();
  await again.resume();
  await idle(again);
  expect(list("kept", day)).toHaveLength(4);
  expect(list("audio", day)).toEqual([]);
});

test("after a restart the audio left is transcribed, what was half taken or done already is dropped", async () => {
  close("go");
  let ended = false;
  const first = start({ busy: () => ended });
  for (const name of [A, B]) await first.take(clip(name));
  await until(() => lines("log").length === 1);
  // The server ends here, Whisper on its first clip: a file half taken, and one whose audio outlived its transcript.
  ended = true;
  open(`audio/${day}/.${C}.m4a.part.m4a`);
  open(`audio/${day}/DONE.MP4.m4a`);
  mkdirSync(join(root, "kept", day), { recursive: true });
  open(`kept/${day}/DONE.vtt`, "WEBVTT\n");
  open(`kept/${day}/DONE.json`, "{}");
  at.records[`${day}/DONE.MP4`] = { size: 5, made: "2026-11-18T12:00:00Z" };
  open("scratch/left", "");
  rmSync(join(root, "log"));
  const records = structuredClone(at.records);

  const second = start();
  await second.resume();
  expect(second.summary()).toMatchObject({ total: 2 });
  expect(list("scratch").filter((file) => !file.startsWith("whisper-"))).toEqual([]);
  open("go");
  await idle(second);
  expect(lines("log").filter((line) => line.startsWith("start"))).toEqual([`start ${A}`, `start ${B}`]);
  expect(list("audio", day)).toEqual([]);
  expect(list("kept", day)).toContain(`${A.slice(0, -4)}.vtt`);
  expect(read("kept", day, "DONE.json")).toBe("{}");
  expect(at.records[`${day}/DONE.MP4`]).toEqual(records[`${day}/DONE.MP4`]);
  ended = false;
  await idle(first);
});

test("a Whisper that outlives its server can't write into another clip's transcript", async () => {
  close("go");
  const first = start();
  await first.take(clip(A));
  await until(() => lines("log").length === 1);
  rmSync(join(root, "audio", day, `${A}.m4a`));
  const second = start();
  await second.take(clip(B));
  await until(() => lines("log").length === 2);
  const outs = lines("calls").map((call) => /--output-dir (\S+)/.exec(call)[1]);
  expect(new Set(outs).size).toBe(2);
  open("go");
  await idle(first);
  await idle(second);
  expect(JSON.parse(read("kept", day, `${B.slice(0, -4)}.json`)).text).toBe(` ${B} NaN`);
});

test("a clip with no sound, or none that can be taken, is no reason to keep it", async () => {
  const silent = start({ extract: async () => false });
  await silent.take(clip(A));
  expect(at.records).toEqual({ [`${day}/${A}`]: { size: 1000, silent: true } });
  expect(silent.summary()).toMatchObject({ total: 0, failed: 0 });
  // Known to be silent, it isn't asked again.
  await start({ extract: () => Promise.reject(new Error("asked")) }).take(clip(A));
  expect(at.logs).toEqual([]);

  const broken = start({ extract: () => Promise.reject(new Error("moov atom not found")) });
  await broken.take(clip(B));
  expect(broken.summary()).toMatchObject({ failed: 1, error: "its sound couldn't be taken: moov atom not found" });
  expect(at.logs).toEqual([`grade: transcripts: ${B}: its sound couldn't be taken: moov atom not found`]);
  // There's no audio to try again with.
  broken.retry();
  expect(broken.summary()).toMatchObject({ failed: 1, total: 0 });

  // Cut short, it says so: the clip stays.
  const stopping = new AbortController();
  const cut = start({
    extract: (_src, _dst, { signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))),
  });
  const taking = cut.take(clip(C), stopping.signal);
  setTimeout(() => stopping.abort(), 20);
  await expect(taking).rejects.toThrow();
  expect(cut.summary()).toMatchObject({ failed: 0 });
});

test("a clip nobody speaks in gets an empty transcript", async () => {
  open("quiet");
  const t = start();
  await t.take(clip(A));
  await idle(t);
  expect(read("kept", day, `${A.slice(0, -4)}.vtt`)).toBe("WEBVTT\n");
  expect(JSON.parse(read("kept", day, `${A.slice(0, -4)}.json`)).segments).toEqual([]);
  expect(at.records[`${day}/${A}`]).toMatchObject({ words: 0 });
  expect(list("audio", day)).toEqual([]);
});

test("a clip kept since its sound was taken isn't transcribed, and its sound waits for when it isn't", async () => {
  const kept = new Set([A]);
  const t = start({ skip: async ({ name }) => kept.has(name) });
  for (const name of [A, B]) await t.take(clip(name));
  await idle(t);
  expect(list("kept", day)).toEqual([`${B.slice(0, -4)}.json`, `${B.slice(0, -4)}.vtt`]);
  expect(list("audio", day)).toEqual([`${A}.m4a`]);
  expect(t.summary()).toMatchObject({ failed: 0, waiting: 0 });
  kept.clear();
  await t.resume();
  await idle(t);
  expect(list("kept", day)).toHaveLength(4);
  expect(list("audio", day)).toEqual([]);
});

test("clips of one name on two days keep their own transcripts", async () => {
  const t = start();
  await t.take(clip("IMG_4857.MOV", "2026-11-17"));
  await t.take(clip("IMG_4857.MOV", "2026-11-18"));
  await idle(t);
  expect(list("kept")).toEqual(["2026-11-17", "2026-11-18"]);
  for (const on of list("kept")) expect(JSON.parse(read("kept", on, "IMG_4857.json")).day).toBe(on);
});

test("the transcripts to send are those made of clips the archive has, each once", async () => {
  const t = start();
  for (const name of [A, B]) await t.take(clip(name));
  await idle(t);
  expect(await t.ready({})).toEqual([]);
  // Landed on another day is another clip.
  expect(await t.ready({ [A]: { day: "2026-11-17" } })).toEqual([]);
  const landed = { [A]: { day }, [C]: { day } };
  const ready = await t.ready(landed);
  expect(ready).toMatchObject([
    {
      key: `${day}/${A}`,
      name: A,
      day,
      files: [
        { path: `transcripts/${A.slice(0, -4)}.vtt`, abs: join(root, "kept", day, `${A.slice(0, -4)}.vtt`) },
        { path: `transcripts/${A.slice(0, -4)}.json`, abs: join(root, "kept", day, `${A.slice(0, -4)}.json`) },
      ],
    },
  ]);
  expect(ready[0].files.every(({ mtime }) => Number.isInteger(mtime))).toBe(true);
  await t.sent([ready[0].key]);
  expect(await t.ready(landed)).toEqual([]);
  expect(await t.filed()).toEqual([A]);
});

test("Whisper's answer is read whatever Python put in it, and its segments written as WebVTT", () => {
  const { text, segments } = parseWhisper(
    '{"text": "a \\"NaN\\" and -Infinity", "segments": [{"avg_logprob": NaN, "x": -Infinity, "y": Infinity}]}',
  );
  expect(text).toBe('a "NaN" and -Infinity');
  expect(segments).toEqual([{ avg_logprob: null, x: null, y: null }]);
  expect(() => parseWhisper('{"text": ""}')).toThrow("no segments");
  expect(() => parseWhisper('{"text": "cut sho')).toThrow();
  expect(
    toVtt([
      { start: 3661.5, end: 3670, text: " Tom & <Jerry> ", words: [] },
      { start: 4000, end: 4001, text: "  " },
    ]),
  ).toBe("WEBVTT\n\n01:01:01.500 --> 01:01:10.000\nTom &amp; &lt;Jerry&gt;\n");
});
