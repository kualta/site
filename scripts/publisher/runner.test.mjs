import { expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { publish } from "./runner.mjs";

function fixture(overrides = {}) {
  return {
    api: async () => new Response("source"),
    oauth: { agent: async () => ({ agent: {} }) },
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

test("text posts publish without fetching media and send X no attachment", async () => {
  let fetched = 0,
    args;
  const text = { ...post, kind: "text", title: "", media: [], metadata: { ...post.metadata, twitter: "remove-all" } };
  const bluesky = await publish(
    { platform: "bluesky" },
    text,
    fixture({
      api: async () => {
        fetched++;
        return new Response("source");
      },
      atproto: async (_platform, _config, files) => {
        expect(files).toEqual([]);
        return { url: "https://example.invalid/text" };
      },
    }),
  );
  expect(bluesky.state).toBe("succeeded");
  expect(fetched).toBe(0);
  await publish(
    { platform: "twitter" },
    text,
    fixture({
      python: async (_script, values) => {
        args = values;
        return { ok: true, url: "https://example.invalid/x" };
      },
    }),
  );
  expect(args[args.indexOf("--kind") + 1]).toBe("none");
  expect(args[args.indexOf("--media") + 1]).toBe("");
});

test("expired OAuth fails before publishing starts", async () => {
  let called = false;
  const result = await publish(
    { platform: "bluesky" },
    post,
    fixture({
      oauth: {
        agent: async () => {
          throw Error("Reconnect with OAuth");
        },
      },
      atproto: async () => {
        called = true;
      },
    }),
  );
  expect(result.state).toBe("failed");
  expect(called).toBe(false);
});

test("each platform publishes its own rendered version", async () => {
  let sent;
  await publish(
    { platform: "bluesky" },
    {
      ...post,
      kind: "text",
      media: [],
      caption: "Shared text",
      variants: { bluesky: { title: "", text: "Bluesky text\n\n#a", tags: ["b", "c"] } },
    },
    fixture({
      atproto: async (_platform, _config, _files, _infos, published) => {
        sent = published;
        return { url: "https://example.invalid/post" };
      },
    }),
  );
  expect(sent.caption).toBe("Bluesky text\n\n#a");
  expect(sent.tags).toEqual(["b", "c"]);
});

test("Instagram stories go through the API with story-sized video", async () => {
  let options;
  let published;
  const result = await publish(
    { platform: "instagram_story" },
    { ...post, kind: "video", media: ["clip"], metadata: { instagram_story: "remove-location" } },
    fixture({
      config: { origin: "https://post.example", token: "helper" },
      process: async (_input, output, opts) => {
        options = opts;
        await writeFile(output, "prepared");
        return { kind: "video", width: 1080, height: 1920, duration: 12, bytes: 8, contentType: "video/mp4" };
      },
      story: async (files, infos, deps) => {
        published = { files, infos, deps };
        return { url: "https://www.instagram.com/stories/kualta/" };
      },
    }),
  );
  expect(result).toEqual({ state: "succeeded", url: "https://www.instagram.com/stories/kualta/", message: "" });
  expect(options.story).toBe(true);
  expect(published.files).toHaveLength(1);
  expect(typeof published.deps.park).toBe("function");
});
test("Instagram stories refuse videos over a minute before publishing", async () => {
  let called = false;
  const result = await publish(
    { platform: "instagram_story" },
    { ...post, kind: "video", media: ["clip"], metadata: { instagram_story: "remove-location" } },
    fixture({
      config: {},
      process: async (_input, output) => {
        await writeFile(output, "prepared");
        return { kind: "video", width: 1080, height: 1920, duration: 75, bytes: 8, contentType: "video/mp4" };
      },
      story: async () => {
        called = true;
      },
    }),
  );
  expect(called).toBe(false);
  expect(result.state).toBe("failed");
  expect(result.message).toContain("3 to 60 seconds");
});
