import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasSession, signedIn, signInWatch } from "./sessions.mjs";

// Chrome's cookie table, as Chrome 158 writes it.
const schema =
  "CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL," +
  "name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL," +
  "is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL," +
  "is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL," +
  "source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL," +
  "has_cross_site_ancestor INTEGER NOT NULL)";
const now = Date.UTC(2026, 10, 24, 12);
/** Chrome's clock: microseconds since 1601. */
const chromeTime = (ms) => (BigInt(ms) + 11_644_473_600_000n) * 1000n;
const year = 365 * 24 * 3_600_000;

/** A profile whose cookie store holds `cookies`: [host, name, expires (ms, or 0 for a session cookie)]. */
async function profile(root, cookies, { store = "Default/Cookies" } = {}) {
  const dir = await mkdtemp(join(root, "profile-"));
  const file = join(dir, store);
  await mkdir(join(file, ".."), { recursive: true });
  const db = new Database(file);
  db.run(schema);
  const insert = db.prepare(
    "INSERT INTO cookies VALUES (0, ?, '', ?, '', ?, '/', ?, 1, 1, 0, ?, ?, 1, 0, 2, 443, 0, 0, 0)",
  );
  for (const [host, name, expires] of cookies)
    insert.run(
      host,
      name,
      new Uint8Array([118, 49, 48, 1, 2, 3]),
      expires ? chromeTime(expires) : 0n,
      expires ? 1 : 0,
      expires ? 1 : 0,
    );
  db.close();
  return dir;
}

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "sign-in-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a profile is signed in while its platform's sign-in cookie is there and current, for that platform's sites", () =>
  withRoot(async (root) => {
    const later = now + year;
    const look = (dir, platform) => signedIn(dir, platform, { now });
    expect(await look(await profile(root, [[".instagram.com", "sessionid", later]]), "instagram")).toBe(true);
    // Kept only for the session, it's still there.
    expect(await look(await profile(root, [[".x.com", "auth_token", 0]]), "twitter")).toBe(true);
    expect(await look(await profile(root, [[".twitter.com", "auth_token", later]]), "twitter")).toBe(true);
    // TikTok keeps its own Chrome profile, the same store; either session cookie does.
    expect(await look(await profile(root, [[".tiktok.com", "sessionid_ss", later]]), "tiktok")).toBe(true);
    // RedNote signs in on rednote.com.
    expect(await look(await profile(root, [[".rednote.com", "web_session", later]]), "xiaohongshu")).toBe(true);
    // YouTube signs with SAPISID, or __Secure-3PAPISID when Chrome keeps only that.
    const youtube = await profile(root, [[".youtube.com", "__Secure-3PAPISID", later]]);
    expect(await look(youtube, "youtube")).toBe(true);
    expect(await look(youtube, "youtube-footage")).toBe(true);
    // Newer Chrome keeps the store under Network.
    const network = await profile(root, [["www.instagram.com", "sessionid", later]], {
      store: "Default/Network/Cookies",
    });
    expect(await look(network, "instagram")).toBe(true);
  }));

test("a profile without the cookie, with it expired or set for another site, or without a store, is signed out", () =>
  withRoot(async (root) => {
    const look = (dir, platform) => signedIn(dir, platform, { now });
    // What every profile held after Chrome 158 emptied them: a visitor's cookies, no sign-in.
    const guest = await profile(root, [
      [".instagram.com", "csrftoken", now + year],
      [".instagram.com", "mid", now + year],
    ]);
    expect(await look(guest, "instagram")).toBe(false);
    expect(await look(await profile(root, []), "tiktok")).toBe(false);
    expect(await look(await profile(root, [[".instagram.com", "sessionid", now - 1000]]), "instagram")).toBe(false);
    // Another site's cookie of the same name isn't this platform's sign-in.
    expect(await look(await profile(root, [[".tiktok.com", "sessionid", now + year]]), "instagram")).toBe(false);
    expect(await look(await profile(root, [[".google.com", "SAPISID", now + year]]), "youtube")).toBe(false);
    expect(await look(await profile(root, [[".notinstagram.com", "sessionid", now + year]]), "instagram")).toBe(false);
    expect(await look(join(root, "never-opened"), "instagram")).toBe(false);
  }));

test("a store that can't be read says nothing either way", () =>
  withRoot(async (root) => {
    const dir = join(root, "broken");
    await mkdir(join(dir, "Default"), { recursive: true });
    await writeFile(join(dir, "Default/Cookies"), "not a database");
    expect(await signedIn(dir, "instagram", { now })).toBe(null);
    expect(await signedIn(await profile(root, []), "farcaster", { now })).toBe(null);
  }));

test("only a copy of the store is read, and only cookies' names, sites and expiry", () =>
  withRoot(async (root) => {
    const dir = await profile(root, [[".instagram.com", "sessionid", now + year]]);
    const store = join(dir, "Default/Cookies");
    const before = { bytes: await readFile(store), mtime: (await stat(store)).mtimeMs };
    const asked = [];
    const { execFileSync } = await import("node:child_process");
    const query = async (file, sql) => {
      asked.push({ file, sql });
      return execFileSync("sqlite3", ["-init", "/dev/null", "-batch", "-noheader", "-separator", "\t", file, sql], {
        encoding: "utf8",
      });
    };
    expect(await signedIn(dir, "instagram", { now, query })).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].file).not.toBe(store);
    expect(asked[0].sql).not.toMatch(/value/);
    expect(asked[0].sql).toMatch(/^SELECT host_key, name FROM cookies /);
    // The copy is gone and the store untouched.
    await expect(stat(asked[0].file)).rejects.toThrow();
    expect(await readFile(store)).toEqual(before.bytes);
    expect((await stat(store)).mtimeMs).toBe(before.mtime);
  }));

test("the cookies a browser gives for a page hold a session when one of the platform's is current", () => {
  expect(hasSession("instagram", [{ name: "sessionid", value: "x", expires: -1 }])).toBe(true);
  expect(hasSession("instagram", [{ name: "sessionid", value: "", expires: -1 }])).toBe(false);
  expect(hasSession("youtube", [{ name: "__Secure-3PAPISID", value: "x", expires: Date.now() / 1000 + 60 }])).toBe(
    true,
  );
  expect(hasSession("tiktok", [{ name: "sessionid", value: "x", expires: 1 }])).toBe(false);
  expect(hasSession("farcaster", [{ name: "sessionid", value: "x", expires: -1 }])).toBe(false);
});

test("the watch tells the site which connected browser accounts are signed out, when that changes and hourly", async () => {
  const sent = [];
  const lines = [];
  let found = { instagram: false, twitter: true, "youtube-footage": false };
  let platforms = ["instagram", "twitter", "grain", "bluesky", "youtube-footage"];
  let clock = 0;
  const watch = signInWatch({
    stateDir: "/state",
    platforms: () => platforms,
    api: async (path, body) => sent.push([path, body]),
    log: (line) => lines.push(line),
    look: async (dir, platform) => {
      expect(dir).toBe(`/state/${platform}`);
      return found[platform];
    },
    now: () => clock,
  });
  await watch.check();
  expect(watch.signedOut()).toEqual(["instagram", "youtube-footage"]);
  // Keyed accounts have no profile to look at.
  expect(sent).toEqual([["sessions", { signedOut: ["instagram", "youtube-footage"] }]]);
  expect(lines).toEqual(["instagram: signed out", "youtube-footage: signed out"]);
  // Unchanged, the site isn't told again until an hour has gone.
  clock += 5 * 60_000;
  await watch.check();
  expect(sent).toHaveLength(1);
  clock += 60 * 60_000;
  await watch.check();
  expect(sent).toHaveLength(2);
  // A store that can't be read keeps what it was; one signed in again is said at once.
  found = { instagram: true, twitter: null, "youtube-footage": null };
  await watch.check();
  expect(watch.signedOut()).toEqual(["youtube-footage"]);
  expect(sent.at(-1)).toEqual(["sessions", { signedOut: ["youtube-footage"] }]);
  expect(lines.at(-1)).toBe("instagram: signed in");
  // Disconnected, it isn't counted.
  platforms = ["instagram", "twitter"];
  await watch.check();
  expect(sent.at(-1)).toEqual(["sessions", { signedOut: [] }]);
});

test("checks run one after another, and a failed report is sent again on the next", async () => {
  let release;
  const order = [];
  let calls = 0;
  const watch = signInWatch({
    stateDir: "/state",
    platforms: () => ["instagram"],
    api: async (_path, body) => {
      order.push(`sent ${body.signedOut.length}`);
      if (++calls === 1) throw new Error("offline");
    },
    log: (line) => order.push(line),
    look: async () => {
      order.push("look");
      if (!release)
        await new Promise((done) => {
          release = done;
        });
      return false;
    },
  });
  const first = watch.check();
  const second = watch.check();
  await new Promise((done) => setTimeout(done, 10));
  expect(order).toEqual(["look"]);
  release();
  await first;
  await second;
  expect(order).toEqual(["look", "instagram: signed out", "sent 1", "Sign-in check failed: offline", "look", "sent 1"]);
});
