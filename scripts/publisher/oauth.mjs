import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import {
  JoseKey,
  NodeOAuthClient,
  TokenInvalidError,
  TokenRefreshError,
  TokenRevokedError,
} from "@atproto/oauth-client-node";
import { Agent } from "@atproto/api";
import { openProfile } from "./browser.mjs";

export const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
/* The site serves this at its client_id (src/pages/publisher-oauth-client-metadata.json.ts). A client that signs its
   token requests with a key of its own is confidential: its session has no fixed end, and each refresh token lasts
   180 days and is replaced on use, where a loopback client's session ends two weeks after sign-in. */
export const clientMetadata = JSON.parse(
  await readFile(new URL("../../src/lib/publisher/oauth-client.json", import.meta.url), "utf8"),
);
export const scope = clientMetadata.scope;
/* The sign-in returns to kualta.dev/auth/publisher, which sends the browser on to this port. */
export const callbackPort = 43827;

/**
 * The signing key at `file`, made with `kid` when there is none, and never over one already there: replacing it
 * would end the session bound to it. The published metadata lists its public half.
 */
export async function ensureClientKey(file, kid) {
  try {
    return { created: false, jwk: publishedJwk(await readKey(file)) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const key = await JoseKey.generate(["ES256"], kid);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify({ ...key.privateJwk, alg: "ES256", key_ops: ["sign"] }), {
    mode: 0o600,
    flag: "wx",
  });
  return { created: true, jwk: publishedJwk(key) };
}

async function readKey(file) {
  return JoseKey.fromJWK(await readFile(file, "utf8"));
}

/** What the metadata's jwks lists for a key: its public half, for signing only. */
function publishedJwk(key) {
  const { kty, crv, x, y, kid } = key.publicJwk;
  return { kty, crv, x, y, kid, alg: "ES256", use: "sig" };
}

/** The signing key the metadata lists, or why there is none. */
async function clientKey(file, metadata) {
  let key;
  try {
    key = await readKey(file);
  } catch (error) {
    if (error.code === "ENOENT")
      return { problem: `Bluesky needs the publisher's signing key at ${file}. Run bun run publisher oauth-key.` };
    return { problem: `The publisher's signing key at ${file} cannot be read: ${error.message}` };
  }
  const published = metadata.jwks?.keys?.find((k) => k.kid === key.kid);
  const own = key.publicJwk;
  if (!published || ["kty", "crv", "x", "y"].some((field) => published[field] !== own[field]))
    return {
      problem: `The publisher's signing key ${key.kid} is not the one in src/lib/publisher/oauth-client.json. Run bun run publisher oauth-key and publish its key.`,
    };
  return { key };
}

export async function fileStore(directory, ttl = Infinity) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = (key) => join(directory, createHash("sha256").update(key).digest("hex") + ".json");
  return {
    async get(key) {
      try {
        const stored = JSON.parse(await readFile(path(key), "utf8"));
        if (Date.now() - stored.savedAt < ttl) return stored.value;
        await this.del(key);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    async set(key, value) {
      const temporary = path(key) + "." + randomUUID();
      await writeFile(temporary, JSON.stringify({ savedAt: Date.now(), value }), { mode: 0o600 });
      await rename(temporary, path(key));
    },
    async clear() {
      for (const file of await readdir(directory)) await rm(join(directory, file), { force: true });
    },
    async del(key) {
      await rm(path(key), { force: true });
    },
  };
}

// Binding a fixed loopback port also prevents two helpers from refreshing the same session.
export async function createOAuth(
  stateDir,
  {
    port = callbackPort,
    open = openProfile,
    clientFactory = (options) => new NodeOAuthClient(options),
    metadata = clientMetadata,
    keyFile = join(stateDir, "oauth/client-key.json"),
  } = {},
) {
  // v3 sessions belonged to the loopback client; a session cannot move to another client.
  const sessions = await fileStore(join(stateDir, "oauth/publishing-v4/sessions"));
  const states = await fileStore(join(stateDir, "oauth/publishing-v4/states"), 10 * 60_000);
  // Without its key only Bluesky and Grain stop; the helper still posts everywhere else.
  const { key, problem } = await clientKey(keyFile, metadata);
  let pending;
  let client;
  let callbackBusy = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    let url;
    try {
      url = new URL(request.url, "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid request.");
      return;
    }
    if (
      request.method !== "GET" ||
      request.headers.host !== `127.0.0.1:${server.address().port}` ||
      url.pathname !== "/oauth/callback" ||
      !pending ||
      callbackBusy
    ) {
      response.writeHead(404).end("No sign-in in progress.");
      return;
    }
    callbackBusy = true;
    const attempt = pending;
    let authorizedSession;
    try {
      // SDK validates issuer, state, PKCE and DPoP; never accept a DID from the browser.
      const { session, state } = await client.callback(url.searchParams);
      authorizedSession = session;
      if (state !== attempt.id || session.did !== owner || pending !== attempt) {
        throw new Error("Unexpected account or authorization");
      }
      await attempt.active();
      response.end("Connected. Return to the publisher.");
      attempt.resolve();
    } catch (error) {
      if (authorizedSession) {
        await client.revoke(authorizedSession.did).catch(() => {});
        await sessions.del(authorizedSession.did);
      }
      if (authorizedSession || error.state === attempt.id)
        attempt.reject(new Error("Authorization failed. Connect again with kualta’s account."));
      response.writeHead(400).end("Authorization failed. Return to the publisher and reconnect.");
      // Invalid unsolicited callbacks cannot cancel the owner's pending authorization.
    } finally {
      callbackBusy = false;
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const callback = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const locks = new Map();
  try {
    client = key && clientFactory({
      clientMetadata: metadata,
      keyset: [key],
      stateStore: states,
      sessionStore: sessions,
      async requestLock(name, fn) {
        const previous = locks.get(name) || Promise.resolve();
        const next = previous.catch(() => {}).then(fn);
        locks.set(name, next);
        try {
          return await next;
        } finally {
          if (locks.get(name) === next) locks.delete(name);
        }
      },
    });
  } catch (error) {
    server.close();
    throw error;
  }
  const usable = () => {
    if (!client) throw new Error(problem);
    return client;
  };
  return {
    callback,
    async connect(active) {
      usable();
      if (pending) throw new Error("A sign-in is already in progress");
      let browser;
      let timer;
      await states.clear();
      const controller = new AbortController();
      const id = randomUUID();
      let resolve, reject;
      const completion = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      // Attach a handler before opening a potentially slow browser window.
      completion.catch(() => {});
      pending = { id, active, resolve, reject };
      const deadline = Date.now() + 10 * 60_000;
      let checking = false;
      timer = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          await active();
          if (Date.now() > deadline) throw new Error("Sign-in timed out. Connect again.");
          if (browser && !browser.pages().length)
            throw new Error("Sign-in window closed. Connect again.");
        } catch (error) {
          controller.abort();
          reject(error);
        } finally {
          checking = false;
        }
      }, 2000);
      try {
        const url = await client.authorize(owner, { state: id, scope, signal: controller.signal });
        browser = await open(join(stateDir, "atproto-browser"));
        const page = browser.pages()[0] || (await browser.newPage());
        await page.goto(String(url));
        await completion;
        await active();
        return owner;
      } catch (error) {
        await client.revoke(owner).catch(() => {});
        await sessions.del(owner);
        throw error;
      } finally {
        clearInterval(timer);
        pending = undefined;
        controller.abort();
        await states.clear();
        await browser?.close();
      }
    },
    async disconnect() {
      try {
        await usable().revoke(owner);
      } catch {
        console.warn("Remote revocation unavailable; removing the local OAuth session.");
      } finally {
        await sessions.del(owner);
      }
    },
    async agent() {
      usable();
      const signedOut = "Grain / Bluesky is signed out. Connect it again in Accounts, then retry.";
      // Without this the SDK reports a missing session as "deleted by another process".
      if (!(await sessions.get(owner))) throw new Error(signedOut);
      let session, info;
      try {
        session = await client.restore(owner);
        info = await session.getTokenInfo();
      } catch (error) {
        // Bluesky ended the sign-in; the SDK has already removed it.
        if (
          error instanceof TokenRefreshError ||
          error instanceof TokenRevokedError ||
          error instanceof TokenInvalidError
        )
          throw new Error(`${signedOut} (${error.message})`);
        throw error;
      }
      if (session.did !== owner) throw new Error("Use kualta’s AT Protocol account");
      return { agent: new Agent(session), pdsUrl: new URL(info.aud) };
    },
    async hasSession() {
      return !!(await sessions.get(owner));
    },
    async close() {
      pending?.reject(new Error("Helper stopped"));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
