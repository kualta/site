import { expect, test } from "bun:test";
import { frameAt, isCameraClip, moveFor, readFilm, splitSource, stretches, trimName, writeSources } from "./film.mjs";
import { moveVtt } from "./vtt.mjs";

const A = "DJI_20261115215124_0306_D.mp4";
const FILM = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1080, height=1920">
<style>
  /* <video src="assets/not-a-clip.mp4"> */
  .card { object-fit: cover; }
</style>
</head>
<body>
<section>
  <iframe id="captions" src="captions.html#t=0,9"></iframe>
</section>
<!-- <video src="assets/commented.mp4"></video> -->
<section>
  <video id="a" src="assets/${A}#t=12.400,15.100" at="0" volume="0" overrides='[{"fade":[0.5,0]},{"at":"p > b","text":"a > b \\"q\\""}]'></video>
  <video id="b" src="assets/${A}#t=18.2" at="2.7" speed="2" volume="0"></video>
  <video id="c" src="assets/IMG_4857.MOV#t=1,2" at="5" disabled></video>
</section>
<section muted>
  <audio id="a-sound" src="assets/${A}#t=12.375,15.125" at="0"></audio>
</section>
<section hidden>
  <video id="alt" src="assets/${A}"></video>
</section>
<section>
  <audio id="bed" src="assets/music/bed.mp3" volume="0.4"></audio>
</section>
</body>
</html>
`;

test("a film's frame and clips, with what they play, whether they're seen or heard, and where their sources stand", () => {
  const { stage, clips, pages } = readFilm(FILM);
  expect(stage).toEqual({ w: 1080, h: 1920 });
  expect(pages).toEqual(["captions.html"]);
  expect(clips.map((c) => [c.id, c.tag, c.path, c.time, c.at, c.speed, c.used])).toEqual([
    ["a", "video", `assets/${A}`, { in: 12.4, out: 15.1 }, 0, 1, true],
    ["b", "video", `assets/${A}`, { in: 18.2, out: null }, 2.7, 2, true],
    ["c", "video", "assets/IMG_4857.MOV", { in: 1, out: 2 }, 5, 1, false],
    // On a muted track: not heard.
    ["a-sound", "audio", `assets/${A}`, { in: 12.375, out: 15.125 }, 0, 1, false],
    // On a hidden track: not seen.
    ["alt", "video", `assets/${A}`, null, 0, 1, false],
    ["bed", "audio", "assets/music/bed.mp3", null, 0, 1, true],
  ]);
  for (const clip of clips) expect(FILM.slice(clip.span.start, clip.span.end)).toBe(clip.src);
});

test("a film without a viewport is 1920 × 1080, and odd fragments read as the SPEC has them", () => {
  expect(readFilm("<body><section><video src='a.mp4'></video></section></body>").stage).toEqual({ w: 1920, h: 1080 });
  expect(splitSource("a.mp4#t=,4").time).toEqual({ in: 0, out: 4 });
  expect(splitSource("a.mp4#t=npt:3").time).toEqual({ in: 3, out: null });
  expect(splitSource("a%20b.mp4#xywh=1,2,3,4").time).toBe(null);
  expect(readFilm('<section><video src="my%20clip.mp4#t=1,2"></video></section>').clips[0].path).toBe("my clip.mp4");
});

test("sources are written over where they stand, and nothing else in the film changes", () => {
  const { clips } = readFilm(FILM);
  const changes = new Map([
    [clips[0].span.start, { end: clips[0].span.end, src: "assets/x-trim1.mp4#t=0.433,3.133" }],
    [clips[3].span.start, { end: clips[3].span.end, src: "assets/x-trim1.mp4#t=0.408,3.158" }],
  ]);
  const out = writeSources(FILM, changes);
  expect(out).toBe(
    FILM.replace(`assets/${A}#t=12.400,15.100`, "assets/x-trim1.mp4#t=0.433,3.133").replace(
      `assets/${A}#t=12.375,15.125`,
      "assets/x-trim1.mp4#t=0.408,3.158",
    ),
  );
  expect(readFilm(out).clips[0].src).toBe("assets/x-trim1.mp4#t=0.433,3.133");
});

test("camera clips are told by the camera's names; music, pictures and a phone's clips aren't", () => {
  expect(isCameraClip(`assets/${A}`)).toBe(true);
  expect(isCameraClip("assets/DJI_20261115215124_0306_D.MP4")).toBe(true);
  expect(isCameraClip("assets/IMG_4857.MOV")).toBe(false);
  expect(isCameraClip("assets/music/bed.mp3")).toBe(false);
  expect(isCameraClip("assets/DJI_0001.JPG")).toBe(false);
});

test("a clip's stretches are handled each side, joined where they overlap or come close, and kept in the clip", () => {
  const use = (from, to) => ({ time: { in: from, out: to } });
  const uses = [use(12.4, 15.1), use(12.375, 15.125), use(14, 16), use(18.2, 19), use(40, 42), use(0.2, 1)];
  expect(stretches(uses, 60).map(({ start, end, uses }) => [start, end, uses.length])).toEqual([
    [0, 1.5, 1],
    // 15.875 + 2 reaches 17.7, where the next starts.
    [11.875, 19.5, 4],
    [39.5, 42.5, 1],
  ]);
  // To the clip's end, and all of it.
  expect(stretches([{ time: { in: 50, out: null } }, { time: null }], 59.6).map((s) => [s.start, s.end])).toEqual([
    [0, 59.6],
  ]);
  expect(stretches([use(1, 2)], 60, { handle: 0, join: 0 }).map((s) => [s.start, s.end])).toEqual([[1, 2]]);
});

test("a trim beside its clip, with the trim's extension", () => {
  expect(trimName(`assets/${A}`, 2, ".mp4")).toBe("assets/DJI_20261115215124_0306_D-trim2.mp4");
  expect(trimName("clip.MOV", 1, "")).toBe("clip-trim1.MOV");
});

const NTSC60 = { num: 60000, den: 1001 };

test("the frame a moment shows is the last begun a millisecond after it, to the microsecond", () => {
  expect(frameAt(0, NTSC60)).toBe(0);
  // Frame 60 begins at 1.001 s exactly.
  expect(frameAt(1, NTSC60)).toBe(60);
  expect(frameAt(0.999, NTSC60)).toBe(59);
  expect(frameAt(1.008, NTSC60)).toBe(60);
  expect(frameAt(0.5, { num: 30, den: 1 }, 0.2)).toBe(9);
});

test("a clip's seconds move by the trim's start, and a video's by a millisecond more where rounding would show the next frame", () => {
  // The trim starts on frame 359 (5.989317 s), its first frame at its own 0.
  const trim = { first: 0, actualStart: (359 * 1001) / 60000 };
  for (let inMs = 6000; inMs < 7000; inMs++) {
    const move = moveFor(inMs / 1000, trim, NTSC60, true);
    expect(Math.abs(move - Math.round(-trim.actualStart * 1000))).toBeLessThanOrEqual(1);
    expect(frameAt((inMs + move) / 1000, NTSC60, trim.first) + 359).toBe(frameAt(inMs / 1000, NTSC60));
  }
  // One that rounding alone gets wrong: from frame 61 (1.017683 s), 2.001 s (frame 120) moved by -1.018 shows 119.
  const from61 = { first: 0, actualStart: (61 * 1001) / 60000 };
  expect(frameAt((2001 - 1018) / 1000, NTSC60) + 61).toBe(119);
  expect(frameAt(2.001, NTSC60)).toBe(120);
  expect(moveFor(2.001, from61, NTSC60, true)).toBe(-1017);
  // Sound has no frames to keep, and a trim not on a frame of the original can't be told; both just round.
  expect(moveFor(12.399, trim, NTSC60, false)).toBe(Math.round(-trim.actualStart * 1000));
  expect(moveFor(12.399, { first: 0.1, actualStart: 5.0031 }, NTSC60, true)).toBe(Math.round((0.1 - 5.0031) * 1000));
});

test("words move with their clip; cues outside the trim go, the rest stay inside it, and the rest of the file stays", () => {
  const vtt = [
    "WEBVTT",
    "",
    "NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.",
    "",
    "STYLE",
    "::cue { color: yellow }",
    "",
    "1",
    "00:00:01.000 --> 00:00:02.000",
    "<00:00:01.000>gone <00:00:01.500>before",
    "",
    "2",
    "00:00:09.500 --> 00:00:11.250 line:80%",
    "<00:00:09.500>half <00:00:10.000>in, <00:00:10.500>here",
    "",
    "00:12.000 --> 00:13.000",
    "<v Ana>whole <00:12.500>one",
    "",
    "00:00:30.000 --> 00:00:31.000",
    "past the end",
    "",
  ].join("\n");
  expect(moveVtt(vtt, -10_000, 15_000)).toBe(
    [
      "WEBVTT",
      "",
      "NOTE Each cue is one subtitle, as cut by hand in OpenFilm Studio.",
      "",
      "STYLE",
      "::cue { color: yellow }",
      "",
      "2",
      "00:00:00.000 --> 00:00:01.250 line:80%",
      "<00:00:00.000>half <00:00:00.000>in, <00:00:00.500>here",
      "",
      "00:00:02.000 --> 00:00:03.000",
      "<v Ana>whole <00:00:02.500>one",
      "",
    ].join("\n"),
  );
  expect(moveVtt("WEBVTT\r\n\r\n00:00:05.000 --> 00:00:06.000\r\nhi\r\n", 1000)).toBe(
    "WEBVTT\r\n\r\n00:00:06.000 --> 00:00:07.000\r\nhi\r\n",
  );
});
