import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { NodeOAuthClient } from "@atproto/oauth-client-node";
import { Agent } from "@atproto/api";
import { openProfile } from "./browser.mjs";

export const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
export const scope = [
  "atproto",
  "repo:app.bsky.feed.post?action=create&action=delete",
  "repo:social.grain.gallery?action=create&action=delete",
  "repo:social.grain.photo?action=create&action=delete",
  "repo:social.grain.gallery.item?action=create&action=delete",
  "blob:image/jpeg",
  "blob:video/mp4",
  "rpc:com.atproto.repo.uploadBlob?aud=*",
].join(" ");

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
    port = 43827,
    open = openProfile,
    clientFactory = (options) => new NodeOAuthClient(options),
  } = {},
) {
  const sessions = await fileStore(join(stateDir, "oauth/publishing-v2/sessions"));
  const states = await fileStore(join(stateDir, "oauth/publishing-v2/states"), 10 * 60_000);
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
  const redirect = `http://127.0.0.1:${server.address().port}/oauth/callback`;
  const params = new URLSearchParams({ redirect_uri: redirect, scope });
  const locks = new Map();
  try {
    client = clientFactory({
      clientMetadata: {
        client_id: `http://localhost?${params}`,
        redirect_uris: [redirect],
        scope,
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        application_type: "native",
        dpop_bound_access_tokens: true,
      },
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
  return {
    redirect,
    async connect(active) {
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
        await client.revoke(owner);
      } catch {
        console.warn("Remote revocation unavailable; removing the local OAuth session.");
      } finally {
        await sessions.del(owner);
      }
    },
    async agent() {
      const session = await client.restore(owner);
      const info = await session.getTokenInfo();
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
