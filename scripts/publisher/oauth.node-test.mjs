import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callbackPort, clientMetadata, createOAuth, ensureClientKey, fileStore, owner, scope } from "./oauth.mjs";

/** A key in `dir` and metadata that lists it, as the published metadata lists the helper's own. */
async function signing(dir, kid = "test-key") {
  const { jwk } = await ensureClientKey(join(dir, "oauth/client-key.json"), kid);
  return { ...clientMetadata, jwks: { keys: [jwk] } };
}

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

test("official OAuth client accepts the confidential metadata with the helper's key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-metadata-"));
  try {
    const oauth = await createOAuth(dir, { port: 0, metadata: await signing(dir) });
    assert.match(oauth.callback, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
    assert.ok(!scope.includes("transition:generic"));
    assert.equal(await oauth.hasSession(), false);
    await oauth.close();
    assert.equal((await stat(join(dir, "oauth/client-key.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("published metadata names a confidential client and its public key only", async () => {
  assert.equal(clientMetadata.client_id, "https://kualta.dev/publisher-oauth-client-metadata.json");
  assert.deepEqual(clientMetadata.redirect_uris, ["https://kualta.dev/auth/publisher"]);
  assert.equal(clientMetadata.token_endpoint_auth_method, "private_key_jwt");
  assert.equal(clientMetadata.token_endpoint_auth_signing_alg, "ES256");
  assert.ok(clientMetadata.jwks.keys.length > 0);
  for (const key of clientMetadata.jwks.keys) assert.ok(!("d" in key), `${key.kid} must be a public key`);
  const page = await readFile(new URL("../../src/pages/auth/publisher.astro", import.meta.url), "utf8");
  assert.ok(page.includes(`"http://127.0.0.1:${callbackPort}/oauth/callback" + location.search`));
});

test("without its key the helper still starts, and Bluesky says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-keyless-"));
  try {
    const oauth = await createOAuth(dir, { port: 0 });
    assert.equal(await oauth.hasSession(), false);
    await assert.rejects(oauth.connect(async () => {}), /signing key .* Run bun run publisher oauth-key/);
    await assert.rejects(oauth.agent(), /signing key/);
    await oauth.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a signed-out helper asks for a reconnect instead of blaming another process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-signed-out-"));
  try {
    const oauth = await createOAuth(dir, { port: 0, metadata: await signing(dir) });
    await assert.rejects(oauth.agent(), /^Error: Grain \/ Bluesky is signed out\. Connect it again in Accounts/);
    await oauth.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a key the published metadata does not list is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-mismatch-"));
  try {
    const listed = await signing(dir, "publisher-2026-11-11");
    const other = await mkdtemp(join(tmpdir(), "oauth-other-"));
    // the same kid as the listed key, different key material
    const metadata = { ...listed, jwks: { keys: [(await signing(other, "publisher-2026-11-11")).jwks.keys[0]] } };
    await rm(other, { recursive: true, force: true });
    const oauth = await createOAuth(dir, { port: 0, metadata });
    await assert.rejects(oauth.agent(), /is not the one in src\/lib\/publisher\/oauth-client\.json/);
    await oauth.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing key is kept, never replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-keep-"));
  try {
    const file = join(dir, "oauth/client-key.json");
    const first = await ensureClientKey(file, "first");
    const again = await ensureClientKey(file, "second");
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.deepEqual(again.jwk, first.jwk);
    assert.deepEqual(Object.keys(first.jwk).sort(), ["alg", "crv", "kid", "kty", "use", "x", "y"]);
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
    metadata: await signing(dir),
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
    assert.equal((await fetch(f.oauth.callback + "?state=invalid")).status, 400);
    assert.equal((await fetch(f.oauth.callback + "?state=valid")).status, 200);
    assert.equal(await connection, owner);
    assert.equal(f.closed(), true);
    assert.equal(await f.oauth.hasSession(), true);
    assert.equal((await fetch(f.oauth.callback + "?state=valid")).status, 404);
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
    assert.equal((await fetch(f.oauth.callback + "?state=valid")).status, 400);
    assert.ok(f.revoked.includes("did:plc:anotherowner"));
    await f.oauth.close();
    await assert.rejects(connection);
    assert.equal(await f.oauth.hasSession(), false);
  } finally {
    await f.cleanup();
  }
});
