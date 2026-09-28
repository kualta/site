import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { publish } from "./runner.mjs";

function fixture(overrides = {}) {
  return {
    api: async () => new Response("source"),
    config: {},
    stateDir: "/unused",
    process: async (_input, output) => {
      await writeFile(output, "prepared");
      return { width: 64, height: 48, duration: 1, bytes: 8 };
    },
    ...overrides,
  };
}
const post = {
  id: "fixture",
  kind: "photo",
  title: "Fixture",
  caption: "Test",
  alt: "Test",
  media: ["one", "two"],
  metadata: {
    grain: "remove-location",
    instagram: "remove-all",
    tiktok: "remove-all",
    bluesky: "remove-all",
  },
};

test("helper prepares all media before publishing once, then deletes temporary files", async () => {
  let paths = [],
    calls = 0;
  const result = await publish(
    { platform: "grain" },
    post,
    fixture({
      atproto: async (platform, _config, files, infos) => {
        calls++;
        paths = files;
        expect(platform).toBe("grain");
        expect(infos).toHaveLength(2);
        for (const file of files) expect(await readFile(file, "utf8")).toBe("prepared");
        return { url: "https://example.invalid/fixture" };
      },
    }),
  );
  expect(calls).toBe(1);
  expect(result.state).toBe("succeeded");
  for (const file of paths) await expect(stat(file)).rejects.toThrow();
});

test("missing media fails before any platform action", async () => {
  let calls = 0;
  const result = await publish(
    { platform: "grain" },
    post,
    fixture({
      api: async () => {
        throw new Error("Media expired");
      },
      atproto: async () => {
        calls++;
      },
    }),
  );
  expect(result).toEqual({ state: "failed", message: "Media expired" });
  expect(calls).toBe(0);
});

test("an interrupted platform action is uncertain and is not repeated", async () => {
  let calls = 0;
  const result = await publish(
    { platform: "grain" },
    post,
    fixture({
      atproto: async () => {
        calls++;
        throw new Error("Connection lost");
      },
    }),
  );
  expect(result.state).toBe("uncertain");
  expect(calls).toBe(1);
});

test("browser adapters without a confirmed URL remain uncertain", async () => {
  const result = await publish(
    { platform: "instagram" },
    post,
    fixture({
      python: async (_script, args) => {
        expect(JSON.parse(args[args.indexOf("--media") + 1])).toHaveLength(2);
        return { ok: true };
      },
    }),
  );
  expect(result.state).toBe("uncertain");
});

test("Bluesky video limits are enforced before invoking the platform", async () => {
  let calls = 0;
  const result = await publish(
    { platform: "bluesky" },
    { ...post, kind: "video", media: ["one"] },
    fixture({
      process: async () => ({ duration: 181, bytes: 20, width: 64, height: 48 }),
      atproto: async () => {
        calls++;
      },
    }),
  );
  expect(result.state).toBe("failed");
  expect(calls).toBe(0);
});
