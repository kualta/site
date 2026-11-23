import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGradeApp, fakeOpenfilm, makeClip } from "./film.fixture.mjs";
import { gradeApp } from "./grade.mjs";
import { probe } from "./media.mjs";
import { renderFilm } from "./render.mjs";

const A = "DJI_20261115215124_0306_D.mp4";
const B = "DJI_20261115215629_0308_D.mp4";
const C = "DJI_20261115221148_0309_D.mp4";

let root;
let originals;
let app;
let film;
let renders;
let record;

const FILM = (viewport = "64, height=36") => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${viewport}">
</head>
<body>
<section>
  <iframe id="captions" src="captions.html#t=0,9"></iframe>
</section>
<section>
  <video id="a1" src="assets/${A}#t=1.400,2.100" at="0" volume="0"></video>
  <video id="a2" src="assets/${A}#t=1.9,3" at="0.7" volume="0"></video>
  <video id="b" src="assets/${B}#t=1.25" at="1.8" overrides='[{"fade":[0.5,0]}]'></video>
  <video id="phone" src="assets/IMG_4857.MOV#t=0,1" at="3.55"></video>
  <video id="a3" src="assets/${A}#t=6.5,7.5" at="4.55" volume="0"></video>
  <video id="off" src="assets/${C}#t=0,1" at="5.55" disabled></video>
</section>
<section>
  <audio id="a-sound" src="assets/${A}#t=1.375,2.125" at="0" overrides='[{"fade":[0.01,0.05]}]'></audio>
</section>
<section>
  <audio id="bed" src="assets/bed.m4a" volume="0.4"></audio>
</section>
</body>
</html>
`;

const VTT =
  "WEBVTT\n\n00:00:01.500 --> 00:00:02.000\n<00:00:01.500>hello <00:00:01.800>there\n\n00:00:07.000 --> 00:00:07.400\nlater\n";

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "film-render-")));
  originals = join(root, "originals");
  mkdirSync(originals);
  await Promise.all([
    makeClip(join(originals, A), { seconds: 8 }),
    makeClip(join(originals, B), { seconds: 3 }),
    makeClip(join(originals, C), { seconds: 2 }),
    makeClip(join(root, "phone.mov"), { seconds: 2 }),
    makeClip(join(root, "bed.m4a"), { seconds: 8 }),
  ]);
  app = await fakeGradeApp({ originals, cache: join(root, "cache"), failing: [], missing: [] });
});
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

/** A film cut from A, B and C as exported, a phone clip and music, with A's words, and its Chinese version. */
function makeFilm(name = "014-test-film", viewport = undefined) {
  film = join(root, "projects", name);
  rmSync(film, { recursive: true, force: true });
  for (const project of [film, join(film, "zh")]) {
    mkdirSync(join(project, "assets"), { recursive: true });
    mkdirSync(join(project, ".film"), { recursive: true });
    for (const clip of [A, B, C]) cpSync(join(originals, clip), join(project, "assets", clip));
    cpSync(join(root, "phone.mov"), join(project, "assets/IMG_4857.MOV"));
    cpSync(join(root, "bed.m4a"), join(project, "assets/bed.m4a"));
    writeFileSync(join(project, "film.html"), FILM(viewport));
    writeFileSync(join(project, "captions.html"), "<script>fetch('captions.json')</script>");
    writeFileSync(join(project, "captions.json"), "[]");
    writeFileSync(join(project, "assets/DJI_20261115215124_0306_D.vtt"), VTT);
    writeFileSync(join(project, ".film/id"), "abc");
    writeFileSync(join(project, ".film/subtitles.json"), project === film ? "{}" : '{"language":"zh"}');
  }
  writeFileSync(join(film, "zh/assets/DJI_20261115215124_0306_D.zh.vtt"), VTT.replace("hello", "你好"));
  writeFileSync(join(film, `${name}.mp4`), "the last render");
  return film;
}

/** Every file of a folder with its size and time, to tell it hasn't changed. */
const snapshot = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((path) => statSync(join(dir, path)).isFile())
    .sort()
    .map((path) => [path, statSync(join(dir, path)).size, statSync(join(dir, path)).mtimeMs]);

beforeEach(() => {
  renders = join(root, "renders");
  record = join(root, "record.json");
  rmSync(record, { force: true });
});

const render = (options = {}) =>
  renderFilm(film, {
    grade: gradeApp({ url: app.url }),
    openfilm: fakeOpenfilm(root, record, options),
    renders,
    log: () => {},
    every: 5,
    output: "ignore",
    ...options,
  });

test("a render asks for trims of what the film plays, renders a copy pointed at them, and leaves the film as it was", async () => {
  makeFilm();
  const before = snapshot(film);
  const asked = app.requests.length;
  const done = await render({ args: ["--loudness=-14"] });

  // One trim per stretch: A's first two uses and its sound joined, its third apart; B to its end; not the disabled C.
  const post = app.requests.slice(asked).find((r) => r.method === "POST" && r.path === "/api/trims");
  expect(post.grade).toBe("1");
  const lengthB = Math.round((await probe(join(originals, B))).duration * 1000);
  expect(post.body.trims).toEqual([
    { name: A, start: 0.875, end: 3.5 },
    { name: A, start: 6, end: 8 },
    { name: B, start: 0.75, end: lengthB / 1000 },
  ]);

  const got = JSON.parse(readFileSync(record, "utf8"));
  expect(got.cwd).toBe(join(renders, "014-test-film"));
  expect(got.args).toEqual(["render", "--out", join(film, "014-test-film.mp4"), "--fps", "30", "--loudness=-14"]);
  // The fake app's trims start on the first frame from each start: 0.9, 6 and 0.766667 s. B, which played to its
  // file's end, ends where that was.
  expect(got.film).toBe(
    FILM()
      .replace(`assets/${A}#t=1.400,2.100`, "assets/DJI_20261115215124_0306_D-trim1.mp4#t=0.5,1.2")
      .replace(`assets/${A}#t=1.9,3`, "assets/DJI_20261115215124_0306_D-trim1.mp4#t=1,2.1")
      .replace(`assets/${A}#t=1.375,2.125`, "assets/DJI_20261115215124_0306_D-trim1.mp4#t=0.475,1.225")
      .replace(`assets/${A}#t=6.5,7.5`, "assets/DJI_20261115215124_0306_D-trim2.mp4#t=0.5,1.5")
      .replace(`assets/${B}#t=1.25`, `assets/DJI_20261115215629_0308_D-trim1.mp4#t=0.483,${(lengthB - 767) / 1000}`),
  );
  // The film's files are all there but its renders, its dot folders and its Chinese version; the trims and their words
  // beside them; and what keeps Studio from opening the copy.
  expect(got.files).toEqual(
    [
      ".film/opened",
      ".film/subtitles.json",
      "assets/DJI_20261115215124_0306_D-trim1.mp4",
      "assets/DJI_20261115215124_0306_D-trim1.vtt",
      "assets/DJI_20261115215124_0306_D-trim2.mp4",
      "assets/DJI_20261115215124_0306_D-trim2.vtt",
      `assets/${A}`,
      "assets/DJI_20261115215124_0306_D.vtt",
      `assets/${B}`,
      "assets/DJI_20261115215629_0308_D-trim1.mp4",
      `assets/${C}`,
      "assets/IMG_4857.MOV",
      "assets/bed.m4a",
      "captions.html",
      "captions.json",
      "film.html",
    ].sort(),
  );
  expect(got.texts["assets/DJI_20261115215124_0306_D-trim1.vtt"]).toBe(
    "WEBVTT\n\n00:00:00.600 --> 00:00:01.100\n<00:00:00.600>hello <00:00:00.900>there\n",
  );
  expect(got.texts["assets/DJI_20261115215124_0306_D-trim2.vtt"]).toBe(
    "WEBVTT\n\n00:00:01.000 --> 00:00:01.400\nlater\n",
  );

  expect(done.out).toBe(join(film, "014-test-film.mp4"));
  expect(readFileSync(done.out, "utf8")).toBe("rendered");
  expect(snapshot(film).filter(([path]) => path !== "014-test-film.mp4")).toEqual(
    before.filter(([path]) => path !== "014-test-film.mp4"),
  );
  expect(existsSync(join(renders, "014-test-film"))).toBe(false);
});

test("the Chinese version renders from zh/, with its own assets and words, beside the original's render", async () => {
  makeFilm();
  const done = await render({ zh: true, args: ["--subtitles"] });
  const got = JSON.parse(readFileSync(record, "utf8"));
  expect(got.cwd).toBe(join(renders, "014-test-film-zh"));
  expect(got.args.slice(0, 3)).toEqual(["render", "--out", join(film, "014-test-film-zh.mp4")]);
  expect(got.args.at(-1)).toBe("--subtitles");
  expect(got.texts["assets/DJI_20261115215124_0306_D-trim1.zh.vtt"]).toContain("<00:00:00.600>你好");
  expect(got.files).toContain(".film/subtitles.json");
  expect(done.out).toBe(join(film, "014-test-film-zh.mp4"));
});

test("a frame smaller than the footage, of its shape, is rendered at the footage's size; a rate given is kept", async () => {
  makeFilm("015-small-frame", "32, height=18");
  await render({ args: ["--fps", "25"] });
  const got = JSON.parse(readFileSync(record, "utf8"));
  expect(got.args).toEqual(["render", "--out", join(film, "015-small-frame.mp4"), "--scale", "2", "--fps", "25"]);
});

test("a trim that fails stops the render before anything is drawn, and says which", async () => {
  makeFilm();
  const failing = await fakeGradeApp({ originals, cache: join(root, "cache2"), failing: [B] });
  try {
    const error = await renderFilm(film, {
      grade: gradeApp({ url: failing.url }),
      openfilm: fakeOpenfilm(root, record),
      renders,
      log: () => {},
      every: 5,
    }).catch((e) => e);
    expect(error.message).toMatch(
      new RegExp(
        `^Nothing was rendered: the grade app couldn't give every trim.\n  ${B} 0.750–3.0\\d\\d s: the camera's card was unplugged$`,
      ),
    );
    expect(existsSync(record)).toBe(false);
  } finally {
    await failing.close();
  }
});

test("a clip only in Cloudflare stops the render, and the owner is told to bring it back", async () => {
  makeFilm();
  const away = await fakeGradeApp({ originals, cache: join(root, "cache3"), missing: [A] });
  try {
    const error = await renderFilm(film, {
      grade: gradeApp({ url: away.url }),
      openfilm: fakeOpenfilm(root, record),
      renders,
      log: () => {},
      every: 5,
    }).catch((e) => e);
    expect(error.message).toContain(`${A} is only in Cloudflare. Bring it back in the grade app`);
    expect(existsSync(record)).toBe(false);
  } finally {
    await away.close();
  }
});

test("a render that stops keeps its copy, and the next one finds it as it was", async () => {
  makeFilm();
  const error = await render({ exit: 3 }).catch((e) => e);
  expect(error.message).toContain(
    `openfilm render stopped (exit 3). The render copy stays at ${join(renders, "014-test-film")}`,
  );
  const first = JSON.parse(readFileSync(record, "utf8"));
  expect(existsSync(join(renders, "014-test-film/film.html"))).toBe(true);
  await render();
  const second = JSON.parse(readFileSync(record, "utf8"));
  // The same files, not copied again: what a stopped render's chunks were drawn from is still there.
  expect(second.inodes["assets/IMG_4857.MOV"]).toBe(first.inodes["assets/IMG_4857.MOV"]);
  expect(second.inodes["film.html"]).toBe(first.inodes["film.html"]);
  expect(existsSync(join(renders, "014-test-film"))).toBe(false);
});

test("a render refuses a range or another output: it's the whole film, to the film's folder", async () => {
  makeFilm();
  expect((await render({ args: ["0-5"] }).catch((e) => e)).message).toContain("0-5: a render here is the whole film");
  expect((await render({ args: ["--out", "x.mp4"] }).catch((e) => e)).message).toContain("--out: a render here");
});
