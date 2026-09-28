import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laptopKeys, decryptCredentials, connectAccount, hasSession } from "./connections.mjs";
import { encryptCredentials, validEncryptedCredentials } from "../../src/lib/publisher/credentials";

test("AT credentials round-trip only with the paired laptop key and reject tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publisher-keys-"));
  const other = await mkdtemp(join(tmpdir(), "publisher-other-"));
  try {
    const keys = await laptopKeys(dir);
    const credentials = {
      service: "https://pds.example",
      identifier: "kualta.dev",
      password: "fixture-private-password",
    };
    const envelope = await encryptCredentials(keys.publicKey, credentials);
    expect(validEncryptedCredentials(envelope)).toBe(true);
    expect(JSON.stringify(envelope)).not.toContain(credentials.password);
    expect(await decryptCredentials(envelope, keys.privateKey)).toEqual(credentials);
    expect((await stat(join(dir, "connection-key.json"))).mode & 0o777).toBe(0o600);
    expect((await laptopKeys(dir)).publicKey).toEqual(keys.publicKey);
    await expect(decryptCredentials(envelope, (await laptopKeys(other)).privateKey)).rejects.toThrow();
    await expect(
      decryptCredentials({ ...envelope, data: "AAAA" + envelope.data.slice(4) }, keys.privateKey),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

function browserFixture(cookies) {
  let closed = false,
    saved = false;
  const config = { platforms: [] };
  const page = { goto: async () => {}, url: () => "https://www.instagram.com/" };
  return {
    config,
    closed: () => closed,
    saved: () => saved,
    deps: {
      config,
      stateDir: "/unused",
      keys: {},
      save: async () => {
        saved = true;
      },
      api: async () => Response.json({ state: "working", confirmed: 1 }),
      open: async () => ({
        pages: () => [page],
        cookies: async () => cookies,
        close: async () => {
          closed = true;
        },
      }),
    },
  };
}
const request = { id: "fixture", platform: "instagram", action: "connect" };
test("browser sign-in requires owner confirmation and a current platform session", async () => {
  const fixture = browserFixture([{ name: "sessionid", value: "fixture", expires: -1 }]);
  const result = await connectAccount(request, fixture.deps);
  expect(result.state).toBe("succeeded");
  expect(fixture.config.platforms).toEqual(["instagram"]);
  expect(fixture.saved()).toBe(true);
  expect(fixture.closed()).toBe(true);
});
test("missing or expired browser sessions do not mark an account connected", async () => {
  const fixture = browserFixture([{ name: "sessionid", value: "old", expires: 1 }]);
  const result = await connectAccount(request, fixture.deps);
  expect(result.state).toBe("failed");
  expect(fixture.config.platforms).toEqual([]);
  expect(fixture.saved()).toBe(false);
  expect(fixture.closed()).toBe(true);
  expect(hasSession("instagram", [{ name: "other", value: "x", expires: -1 }])).toBe(false);
});
test("cancelled connection does not open a browser or save an account", async () => {
  const fixture = browserFixture([]);
  let opened = false;
  const result = await connectAccount(request, {
    ...fixture.deps,
    api: async () => Response.json({ state: "cancelled" }),
    open: async () => {
      opened = true;
      throw Error("must not open");
    },
  });
  expect(result.state).toBe("failed");
  expect(opened).toBe(false);
  expect(fixture.saved()).toBe(false);
});
test("AT Protocol rejects a different account and never persists its password", async () => {
  const dir = await mkdtemp(join(tmpdir(), "publisher-owner-"));
  try {
    const keys = await laptopKeys(dir);
    const payload = await encryptCredentials(keys.publicKey, {
      service: "https://pds.example",
      identifier: "other.example",
      password: "private",
    });
    const fixture = browserFixture([]);
    const result = await connectAccount(
      { ...request, platform: "grain", payload: JSON.stringify(payload) },
      {
        ...fixture.deps,
        keys,
        agentFactory: () => ({ login: async () => {}, session: { did: "did:plc:anotherowner" } }),
      },
    );
    expect(result.state).toBe("failed");
    expect(fixture.saved()).toBe(false);
    expect(fixture.config.platforms).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("helper refuses unrecognized platform paths before touching local profiles", async () => {
  const fixture = browserFixture([]);
  const result = await connectAccount(
    { ...request, platform: "../outside", action: "disconnect" },
    fixture.deps,
  );
  expect(result).toEqual({ state: "failed", message: "Unsupported account action" });
  expect(fixture.saved()).toBe(false);
});
