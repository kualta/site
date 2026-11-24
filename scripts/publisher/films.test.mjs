import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describePlan, localFilms, numberPieces, planNumbers, slugOf, startFilm } from "./films.mjs";

const minute = 60_000;
const piece = (id, title, created_at, extra = {}) => ({
  id,
  title,
  stage: "posted",
  job_id: null,
  created_at,
  number: null,
  ...extra,
});

test("a film's folder is named from its piece's title", () => {
  expect(slugOf("Baking one big chocolate chip cookie while France is burning")).toBe(
    "baking-one-big-chocolate-chip-cookie-while",
  );
  expect(slugOf("You're prettier than this, btw *nature*")).toBe("youre-prettier-than-this-btw-nature");
  expect(slugOf("Bogotá: café")).toBe("bogota-cafe");
  expect(slugOf("波哥大")).toBe("film");
  expect(slugOf("x".repeat(60))).toBe("x".repeat(48));
});

test("each posted film's piece takes its number; the rest count on after the films, oldest first", () => {
  const pieces = [
    piece("text", "meow", 5),
    piece("same", "Big cookie", 30, { job_id: "job-same" }),
    piece("timed", "Square windows", 20, { job_id: "job-timed" }),
    piece("late", "Uploaded too late", 25, { job_id: "job-late" }),
    piece("idea", "Hammock physics", 40, { stage: "idea" }),
    piece("done", "Numbered since", 50, { number: 17 }),
  ];
  const at = Date.UTC(2026, 10, 8);
  const films = [
    { name: "015-big-cookie", number: 15, renders: [{ md5: "a".repeat(32), mtime: at }] },
    // Re-encoded to go up, so only its timing tells.
    {
      name: "011-square-windows",
      number: 11,
      renders: [
        { md5: null, mtime: at },
        { md5: null, mtime: at + 5 * minute },
      ],
    },
    { name: "012-walk", number: 12, renders: [{ md5: "b".repeat(32), mtime: at + 60 * minute }] },
    { name: "003-unbothered", number: 3, renders: [] },
  ];
  const uploads = new Map([
    ["job-same", at + 2 * minute],
    ["job-timed", at + 6 * minute],
    // An hour and a half after 012's render: not its post.
    ["job-late", at + 150 * minute],
  ]);
  const posted = new Map([["a".repeat(32), ["job-same"]]]);
  const plan = planNumbers({ pieces, films, uploads, posted });
  expect(plan.matches.map((m) => [m.film.name, m.piece.id, m.how])).toEqual([
    ["011-square-windows", "timed", "uploaded"],
    ["015-big-cookie", "same", "same"],
  ]);
  expect(plan.unmatched.map((film) => film.name)).toEqual(["003-unbothered", "012-walk"]);
  expect(plan.assign.map(({ piece, number }) => [piece.id, number])).toEqual([
    ["timed", 11],
    ["same", 15],
    ["text", 18],
    ["late", 19],
    ["idea", 20],
  ]);
  expect(describePlan(plan)).toEqual([
    "011  Square windows  ← 011-square-windows: its video went up 1 min after the render",
    "015  Big cookie  ← 015-big-cookie: the render is its video",
    "018  meow",
    "019  Uploaded too late",
    "020  Hammock physics",
    "No piece went out as 003-unbothered, 012-walk",
    "1 piece has its number already",
  ]);

  // Run again once written, it has nothing left to do, and numbers given stay as they are.
  const numbered = pieces.map((p) => ({
    ...p,
    number: plan.assign.find((a) => a.piece.id === p.id)?.number ?? p.number,
  }));
  const again = planNumbers({ pieces: numbered, films, uploads, posted });
  expect(again.assign).toEqual([]);
  expect(again.clashes).toEqual([]);
  const moved = numbered.map((p) => (p.id === "timed" ? { ...p, number: 30 } : p));
  expect(planNumbers({ pieces: moved, films, uploads, posted }).clashes).toEqual([
    "011-square-windows went out as “Square windows”, which is numbered 030 already",
  ]);
});

test("a post goes to the film rendered closest before it, and to only one", () => {
  const at = Date.UTC(2026, 10, 4);
  const films = [
    { name: "006-credit", number: 6, renders: [{ md5: null, mtime: at }] },
    { name: "007-some", number: 7, renders: [{ md5: null, mtime: at + 3 * minute }] },
  ];
  const pieces = [piece("p", "Part 2", 1, { job_id: "j" })];
  const plan = planNumbers({ pieces, films, uploads: new Map([["j", at + 4 * minute]]), posted: new Map() });
  expect(plan.matches.map((m) => m.film.name)).toEqual(["007-some"]);
  expect(plan.unmatched.map((f) => f.name)).toEqual(["006-credit"]);
});

test("a piece's film opens where it is, or is made from its title, never over an archived one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "films-"));
  try {
    const opened = [];
    // As OpenFilm's open does: makes the project when the folder has none.
    const open = async (path) => {
      opened.push(path);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, "film.html"), "<!doctype html>");
    };
    const made = await startFilm({ number: 17, title: "Big cookie" }, { dir, open });
    expect(made).toEqual({ path: join(dir, "017-big-cookie"), made: true });
    // Renamed since, it's still piece 17's.
    const again = await startFilm({ number: 17, title: "One big cookie" }, { dir, open });
    expect(again).toEqual({ path: join(dir, "017-big-cookie"), made: false });
    expect(await localFilms(dir)).toEqual(["017-big-cookie"]);
    await expect(
      startFilm({ number: 13, title: "Maybe later" }, { dir, archived: ["013-maybe-later"], open }),
    ).rejects.toThrow("restore 013-maybe-later");
    await expect(startFilm({ number: null, title: "Old" }, { dir, open })).rejects.toThrow("no number");
    await expect(startFilm({ number: 18, title: "Nothing" }, { dir, open: async () => {} })).rejects.toThrow(
      "OpenFilm made no project",
    );
    expect(opened).toEqual([join(dir, "017-big-cookie"), join(dir, "017-big-cookie")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("numbering reads the films' renders once, plans before the migration, and writes only what's left", async () => {
  const dir = await mkdtemp(join(tmpdir(), "films-"));
  try {
    const render = Buffer.from("the render");
    const sha = createHash("sha256").update(render).digest("hex");
    const md5 = createHash("md5").update(render).digest("hex");
    const at = Date.UTC(2026, 10, 15);
    // On the laptop, film 020, rendered and not posted.
    await mkdir(join(dir, "020-walk"));
    await writeFile(join(dir, "020-walk/020-walk.mp4"), "local render");
    await utimes(join(dir, "020-walk/020-walk.mp4"), new Date(at), new Date(at));
    const asked = [];
    const request = async (path, { json } = {}) => {
      asked.push(path);
      if (path === "projects") return { projects: [{ name: "013-maybe-later" }, { name: "_originals-2026-11-08" }] };
      if (path === "projects/013-maybe-later")
        return { files: [{ path: "013-maybe-later.mp4", sha256: sha, size: render.length, mtime: at }] };
      if (path === `blobs/${sha}`) return new Response(render);
      if (path === "posted") return { posted: json.md5s.includes(md5) ? [{ md5, job: "job" }] : [] };
      throw new Error(path);
    };
    let numbers = false;
    const rows = [piece("p", "time to go out love", 1, { job_id: "job" }), piece("q", "meow", 2)];
    const writes = [];
    const query = async (sql) => {
      if (sql.startsWith("UPDATE")) {
        writes.push(sql);
        for (const [, number, id] of sql.matchAll(/SET number = (\d+) WHERE id = '([^']+)'/g))
          rows.find((row) => row.id === id).number = Number(number);
        return [];
      }
      if (sql.includes("publisher_media")) return [{ job_id: "job", at: at + minute }];
      if (sql.includes("number IS NOT NULL")) return rows.filter((row) => row.number !== null);
      if (!numbers && sql.includes("number"))
        throw Object.assign(new Error("no such column: number"), { said: "no such column: number" });
      return rows.map(({ number, ...row }) => (numbers ? { ...row, number } : row));
    };
    const cache = join(dir, "md5.json");
    const ids = (plan) => plan.assign.map(({ piece, number }) => [piece.id, number]);
    const before = await numberPieces({ query, request, dir, cache });
    expect(before.missingColumn).toBe(true);
    // 013's piece by its render; the other after film 020, on the laptop.
    expect(ids(before)).toEqual([
      ["p", 13],
      ["q", 21],
    ]);
    expect(before.matches[0].how).toBe("same");
    await expect(numberPieces({ query, request, dir, cache, dryRun: false })).rejects.toThrow("0015");
    expect(JSON.parse(await readFile(cache, "utf8"))).toEqual({ [sha]: md5 });
    numbers = true;
    const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
    rows[0].id = id(1);
    rows[1].id = id(2);
    const done = await numberPieces({ query, request, dir, cache, dryRun: false });
    expect(done.written).toBe(2);
    expect(writes).toEqual([
      `UPDATE publisher_content SET number = 13 WHERE id = '${id(1)}' AND number IS NULL;\n` +
        `UPDATE publisher_content SET number = 21 WHERE id = '${id(2)}' AND number IS NULL;`,
    ]);
    expect((await numberPieces({ query, request, dir, cache, dryRun: false })).assign).toEqual([]);
    // The render was read from the archive once.
    expect(asked.filter((path) => path.startsWith("blobs/"))).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
