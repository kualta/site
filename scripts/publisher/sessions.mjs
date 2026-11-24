import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// YouTube's API signs with SAPISID, which Chrome sometimes keeps only as __Secure-3PAPISID (youtubeCookie in browser.mjs).
const youtube = { names: ["SAPISID", "__Secure-3PAPISID"], sites: ["youtube.com"] };
/**
 * The cookie each browser account keeps exactly while it's signed in, by name, and the sites it's set for. Connecting
 * checks for it in the window the owner signed in to, and the helper looks for it in each profile's cookie store.
 */
export const signInCookies = {
  instagram: { names: ["sessionid"], sites: ["instagram.com"] },
  twitter: { names: ["auth_token"], sites: ["x.com", "twitter.com"] },
  youtube,
  // The footage archive's own channel (FOOTAGE in footage.mjs), in its own profile.
  "youtube-footage": youtube,
  tiktok: { names: ["sessionid", "sessionid_ss"], sites: ["tiktok.com"] },
  // RedNote accounts sign in on rednote.com (destination in browser.mjs).
  xiaohongshu: { names: ["web_session"], sites: ["xiaohongshu.com", "rednote.com"] },
};

/** Whether a signed-in session is among cookies a browser gave for the platform's page: one of its cookies, current. */
export function hasSession(platform, cookies) {
  const names = signInCookies[platform]?.names ?? [];
  return cookies.some(
    (cookie) =>
      names.includes(cookie.name) && cookie.value && (cookie.expires === -1 || cookie.expires > Date.now() / 1000),
  );
}

/** What a post, or the footage uploader, says when its profile has lost the sign-in. */
export const signedOutMessage = (name) => `${name} is signed out. Sign in again from Accounts, then retry.`;

/** Seconds from 1601, where Chrome's cookie clock starts, to 1970. */
const CHROME_EPOCH = 11_644_473_600;

/** The profile's cookie store: under Network in newer Chrome, beside it before. */
async function cookieStore(profile) {
  for (const file of [join(profile, "Default", "Network", "Cookies"), join(profile, "Default", "Cookies")]) {
    const found = await stat(file).catch(() => null);
    if (found?.isFile()) return file;
  }
  return null;
}

/** Runs a query on an SQLite file with the system's sqlite3, rows as tab-separated lines. */
async function sqlite(file, query) {
  const args = ["-init", "/dev/null", "-batch", "-noheader", "-separator", "\t", file, query];
  return (await exec("sqlite3", args, { timeout: 10_000 })).stdout;
}

/**
 * Whether the Chrome profile at `profile` holds the platform's sign-in cookie, read from a copy of its cookie store,
 * never the store itself, which the profile's Chrome may hold open: true or false, or null when it can't be read. Only
 * names, sites and expiry are read, never a value. A profile without a store has never kept a sign-in.
 */
export async function signedIn(profile, platform, { now = Date.now(), query = sqlite } = {}) {
  const wanted = signInCookies[platform];
  if (!wanted) return null;
  const store = await cookieStore(profile);
  if (!store) return false;
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "kualta-sign-in-"));
    const copy = join(dir, "Cookies");
    await copyFile(store, copy);
    // A write Chrome was making when it was copied is rolled back from its journal, as Chrome would on opening it.
    for (const journal of ["-journal", "-wal"]) await copyFile(store + journal, copy + journal).catch(() => {});
    const names = wanted.names.map((name) => `'${name}'`).join(",");
    const rows = await query(
      copy,
      `SELECT host_key, name FROM cookies WHERE name IN (${names}) ` +
        `AND (has_expires = 0 OR expires_utc > ${Math.floor(now / 1000) + CHROME_EPOCH} * 1000000)`,
    );
    return rows
      .split("\n")
      .filter(Boolean)
      .some((row) => {
        const host = row.split("\t")[0].replace(/^\./, "");
        return wanted.sites.some((site) => host === site || host.endsWith(`.${site}`));
      });
  } catch {
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** How often the profiles are looked at, and the most time between reports to the site when nothing changes. */
export const CHECK_EVERY = 5 * 60_000;
const REPORT_EVERY = 60 * 60_000;

/**
 * Keeps track of which connected browser accounts' profiles are signed out: `check()` looks at each profile's cookie
 * store (a Chrome update once emptied all of them while Accounts still said Connected) and tells the site, through
 * `api("sessions", { signedOut })`, when that changes and hourly, so its copy never expires. A profile that can't be read
 * keeps what it was last found to be. Checks run one at a time, so one made after a sign-in reports last.
 */
export function signInWatch({ stateDir, platforms, api, log = () => {}, look = signedIn, now = Date.now }) {
  let signedOut = [];
  let reported = null;
  let reportedAt = 0;
  let checking = Promise.resolve();
  const run = async () => {
    const connected = platforms().filter((platform) => Object.hasOwn(signInCookies, platform));
    const found = await Promise.all(connected.map((platform) => look(join(stateDir, platform), platform)));
    const next = connected.filter(
      (platform, i) => found[i] === false || (found[i] === null && signedOut.includes(platform)),
    );
    for (const platform of next) if (!signedOut.includes(platform)) log(`${platform}: signed out`);
    for (const platform of signedOut)
      if (connected.includes(platform) && !next.includes(platform)) log(`${platform}: signed in`);
    signedOut = next;
    const text = JSON.stringify(next);
    if (text === reported && now() - reportedAt < REPORT_EVERY) return;
    await api("sessions", { signedOut: next });
    reported = text;
    reportedAt = now();
  };
  return {
    check() {
      checking = checking.then(run).catch((error) => log(`Sign-in check failed: ${error.message}`));
      return checking;
    },
    signedOut: () => signedOut,
  };
}
