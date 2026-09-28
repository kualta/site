import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuth, fileStore, owner, scope } from "./oauth.mjs";

test("OAuth stores persist privately, expire state and delete sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-store-"));
  try {
    const store = await fileStore(dir);
    await store.set("../../account", { token: "fixture" });
    assert.deepEqual(await (await fileStore(dir)).get("../../account"), { token: "fixture" });
    const [file] = await readdir(dir);
    assert.equal((await stat(join(dir, file))).mode & 0o777, 0o600);
    assert.equal(await (await fileStore(dir, 0)).get("../../account"), undefined);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("official OAuth client accepts the native loopback metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-metadata-"));
  try {
    const oauth = await createOAuth(dir, { port: 0 });
    assert.match(oauth.redirect, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.ok(!scope.includes("transition:generic"));
    assert.equal(await oauth.hasSession(), false);
    await oauth.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function fixture(callbackDid = owner) {
  const dir = await mkdtemp(join(tmpdir(), "oauth-callback-"));
  let appState,
    oauth,
    closed = false,
    opened,
    revoked = [];
  let options;
  oauth = await createOAuth(dir, {
    port: 0,
    clientFactory: (input) => {
      options = input;
      return {
        authorize: async (did, params) => {
          assert.equal(did, owner);
          appState = params.state;
          return new URL("https://provider.example/authorize");
        },
        callback: async (params) => {
          if (params.get("state") !== "valid") throw Error("Invalid state");
          await options.sessionStore.set(callbackDid, { fixture: true });
          return { state: appState, session: { did: callbackDid } };
        },
        revoke: async (did) => {
          revoked.push(did);
          await options.sessionStore.del(did);
        },
      };
    },
    open: async () => ({
      pages: () => [
        {
          goto: async (url) => {
            opened = url;
          },
        },
      ],
      close: async () => {
        closed = true;
      },
    }),
  });
  return {
    oauth,
    options,
    revoked,
    opened: () => opened,
    closed: () => closed,
    cleanup: async () => {
      await oauth.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("OAuth callback connects only the owner and ignores unsolicited callbacks", async () => {
  const f = await fixture();
  try {
    const connection = f.oauth.connect(async () => {});
    while (!f.opened()) await new Promise((r) => setTimeout(r, 1));
    assert.equal((await fetch(f.oauth.redirect + "?state=invalid")).status, 400);
    assert.equal((await fetch(f.oauth.redirect + "?state=valid")).status, 200);
    assert.equal(await connection, owner);
    assert.equal(f.closed(), true);
    assert.equal(await f.oauth.hasSession(), true);
    assert.equal((await fetch(f.oauth.redirect + "?state=valid")).status, 404);
    await f.oauth.disconnect();
    assert.equal(await f.oauth.hasSession(), false);
  } finally {
    await f.cleanup();
  }
});

test("OAuth cancellation removes sessions and closes the login window", async () => {
  const f = await fixture();
  let cancelled = false;
  try {
    const connection = f.oauth.connect(async () => {
      if (cancelled) throw Error("cancelled");
    });
    while (!f.opened()) await new Promise((r) => setTimeout(r, 1));
    cancelled = true;
    await assert.rejects(connection, /cancelled/);
    assert.equal(f.closed(), true);
    assert.equal(await f.oauth.hasSession(), false);
  } finally {
    await f.cleanup();
  }
});

test("OAuth callback revokes a different account", async () => {
  const f = await fixture("did:plc:anotherowner");
  try {
    const connection = f.oauth.connect(async () => {});
    connection.catch(() => {});
    while (!f.opened()) await new Promise((r) => setTimeout(r, 1));
    assert.equal((await fetch(f.oauth.redirect + "?state=valid")).status, 400);
    assert.ok(f.revoked.includes("did:plc:anotherowner"));
    await f.oauth.close();
    await assert.rejects(connection);
    assert.equal(await f.oauth.hasSession(), false);
  } finally {
    await f.cleanup();
  }
});
