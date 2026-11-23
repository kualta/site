import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGradeApp, makeClip } from "./film.fixture.mjs";
import { gradeApp } from "./grade.mjs";
import { filmStatus, makePreviews } from "./previews.mjs";

const A = "DJI_20261115215124_0306_D.mp4";
const B = "DJI_20261115215629_0308_D.mp4";
const GONE = "DJI_20261115221148_0309_D.mp4";

let root;
let originals;
let app;

const FILM = `<!doctype html>
<html><head><meta name="viewport" content="width=64, height=36"></head>
<body>
<section>
  <video src="assets/${A}#t=0.5,1.5" at="0"></video>
  <video src="assets/${B}#t=1" at="1"></video>
  <video src="assets/IMG_4857.MOV#t=0,1" at="3"></video>
  <video src="assets/${GONE}#t=0,1" at="4"></video>
</section>
<section><audio src="assets/${A}#t=0.4,1.6" at="0"></audio><audio src="assets/bed.m4a"></audio></section>
</body></html>
`;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "film-previews-")));
  originals = join(root, "originals");
  mkdirSync(originals);
  await Promise.all([
    makeClip(join(originals, A), { seconds: 3 }),
    makeClip(join(originals, B), { seconds: 2 }),
    makeClip(join(root, "phone.mov"), { seconds: 1 }),
  ]);
  app = await fakeGradeApp({ originals, cache: join(root, "cache"), missing: [GONE] });
});
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

function makeFilm() {
  const film = join(root, "projects", "014-test-film");
  rmSync(film, { recursive: true, force: true });
  for (const project of [film, join(film, "zh")]) {
    mkdirSync(join(project, "assets"), { recursive: true });
    cpSync(join(originals, A), join(project, "assets", A));
    cpSync(join(originals, B), join(project, "assets", B));
    cpSync(join(root, "phone.mov"), join(project, "assets/IMG_4857.MOV"));
    writeFileSync(join(project, "assets/bed.m4a"), "music");
    writeFileSync(join(project, "film.html"), FILM);
    writeFileSync(join(project, "assets/DJI_20261115215124_0306_D.vtt"), "WEBVTT\n");
  }
  // Only in Cloudflare by now, though the film still has its copy.
  cpSync(join(originals, B), join(film, "assets", GONE));
  // A transcript older than its clip stays as it was: it wasn't current before either.
  utimesSync(join(film, "assets/DJI_20261115215629_0308_D.mp4"), new Date(), new Date());
  writeFileSync(join(film, "assets/DJI_20261115215629_0308_D.vtt"), "WEBVTT\n");
  utimesSync(join(film, "assets/DJI_20261115215629_0308_D.vtt"), new Date(1000), new Date(1000));
  return film;
}

const grade = () => gradeApp({ url: app.url });
const same = (a, b) => readFileSync(a).equals(readFileSync(b));

test("previews go in under the clips' names, the originals move into .originals/, and nothing else is touched", async () => {
  const film = makeFilm();
  const phone = statSync(join(film, "assets/IMG_4857.MOV"));
  const lines = [];
  const done = await makePreviews(film, { grade: grade(), log: (line) => lines.push(line), every: 5 });

  for (const project of [film, join(film, "zh")]) {
    for (const clip of [A, B]) {
      expect(same(join(project, "assets/.originals", clip), join(originals, clip))).toBe(true);
      expect(same(join(project, "assets", clip), join(originals, clip))).toBe(false);
    }
    // The transcript current with A is current with its preview, the same sound at the same times.
    expect(statSync(join(project, "assets/DJI_20261115215124_0306_D.vtt")).mtimeMs).toBeGreaterThanOrEqual(
      statSync(join(project, "assets", A)).mtimeMs,
    );
  }
  expect(statSync(join(film, "assets/DJI_20261115215629_0308_D.vtt")).mtimeMs).toBe(1000);
  // Not a camera clip, and not the grade app's: as it was.
  expect(statSync(join(film, "assets/IMG_4857.MOV")).ino).toBe(phone.ino);
  expect(readFileSync(join(film, "assets/bed.m4a"), "utf8")).toBe("music");
  expect(existsSync(join(film, "assets/.originals/IMG_4857.MOV"))).toBe(false);

  expect(done.placed.sort()).toEqual([`assets/${A}`, `assets/${B}`, `zh/assets/${A}`, `zh/assets/${B}`].sort());
  expect(done.missing).toEqual([GONE]);
  expect(lines).toContain(`assets/${A}: the original is kept in assets/.originals/${A}`);
  expect(lines).toContain(`zh/assets/${A}: the original is kept in zh/assets/.originals/${A}`);
  expect(lines.at(-1)).toBe(
    `${GONE} is only in Cloudflare. Bring it back in the grade app (Clips from → Cloudflare, the clip's day, Bring), then run this again.`,
  );
  const ask = app.requests.find((r) => r.method === "POST" && r.path === "/api/previews");
  expect(ask.grade).toBe("1");
  expect(ask.body.names).toEqual([A, B, GONE]);

  // Asked again with nothing regraded: nothing changes.
  const before = statSync(join(film, "assets", A));
  const again = await makePreviews(film, { grade: grade(), log: () => {}, every: 5 });
  expect(again.placed).toEqual([]);
  expect(again.current.length).toBe(4);
  expect(statSync(join(film, "assets", A)).ino).toBe(before.ino);
});

test("status says which clips are current, outdated, original, missing or only in Cloudflare", async () => {
  const film = makeFilm();
  await makePreviews(film, { grade: grade(), log: () => {}, every: 5 });
  rmSync(join(film, "zh/assets", B));
  // A clip of the film put back as exported, by hand, is an original again.
  cpSync(join(originals, B), join(film, "assets", B));
  app.regrade(A);
  const { rows } = await filmStatus(film, { grade: grade() });
  expect(rows.map((r) => [r.project, r.path, r.state])).toEqual([
    ["", `assets/${A}`, "stale"],
    ["", `assets/${B}`, "original"],
    ["", `assets/${GONE}`, "cloudflare"],
    ["zh", `assets/${A}`, "stale"],
    ["zh", `assets/${B}`, "missing"],
    ["zh", `assets/${GONE}`, "missing"],
  ]);

  // Regraded: asked again, A's new preview goes in, and A's original stays the one exported.
  const done = await makePreviews(film, { grade: grade(), log: () => {}, every: 5 });
  expect(done.placed.sort()).toEqual([`assets/${A}`, `assets/${B}`, `zh/assets/${A}`, `zh/assets/${B}`].sort());
  expect(same(join(film, "assets/.originals", A), join(originals, A))).toBe(true);
  // B was put back by hand while its original was kept: both are kept.
  expect(existsSync(join(film, "assets/.originals", B))).toBe(true);
  expect(readFileSync(join(film, "assets/.originals/previews.json"), "utf8").includes(`"assets/${A}"`)).toBe(true);
  const after = await filmStatus(film, { grade: grade() });
  expect(after.rows.map((r) => r.state)).toEqual(["current", "current", "cloudflare", "current", "current", "missing"]);
});

test("status still reads the film when the grade app isn't there", async () => {
  const film = makeFilm();
  const { rows, unreachable } = await filmStatus(film, { grade: gradeApp({ url: "http://127.0.0.1:9" }) });
  expect(unreachable).toContain("The grade app isn't answering at http://127.0.0.1:9");
  expect(rows.map((r) => r.state)).toEqual(["original", "original", "original", "original", "original", "missing"]);
});
