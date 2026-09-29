import { expect, test } from "bun:test";
import { connectAccount, hasSession } from "./connections.mjs";

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
      login: async () => {},
      stateDir: "/unused",
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
test("OAuth connects Grain and Bluesky together without credentials", async () => {
  const fixture = browserFixture([]);
  const did = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
  const result = await connectAccount(
    { ...request, platform: "grain" },
    {
      ...fixture.deps,
      oauth: {
        connect: async (active) => {
          await active();
          return did;
        },
      },
    },
  );
  expect(result.state).toBe("succeeded");
  expect(fixture.config.atproto).toEqual({ did });
  expect(fixture.config.platforms).toEqual(["grain", "bluesky"]);
  expect(fixture.saved()).toBe(true);
});
test("OAuth failure never marks an account connected", async () => {
  const fixture = browserFixture([]);
  const result = await connectAccount(
    { ...request, platform: "grain" },
    {
      ...fixture.deps,
      oauth: {
        connect: async () => {
          throw Error("Authorization denied");
        },
      },
    },
  );
  expect(result.state).toBe("failed");
  expect(fixture.config.platforms).toEqual([]);
  expect(fixture.saved()).toBe(false);
});

test("helper refuses unrecognized platform paths before touching local profiles", async () => {
  const fixture = browserFixture([]);
  const result = await connectAccount({ ...request, platform: "../outside", action: "disconnect" }, fixture.deps);
  expect(result).toEqual({ state: "failed", message: "Unsupported account action" });
  expect(fixture.saved()).toBe(false);
});

test("manual login finishes before automation opens the saved profile", async () => {
  const f = browserFixture([{ name: "sessionid", value: "fixture", expires: -1 }]);
  const order = [];
  const result = await connectAccount(request, {
    ...f.deps,
    login: async (path, url, active) => {
      expect(path).toBe("/unused/instagram");
      expect(url).toBe("https://www.instagram.com/");
      await active();
      order.push("manual");
    },
    open: async (...args) => {
      order.push("automated");
      return f.deps.open(...args);
    },
  });
  expect(result.state).toBe("succeeded");
  expect(order).toEqual(["manual", "automated"]);
});
