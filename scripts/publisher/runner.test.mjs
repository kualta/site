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

const video = { ...post, kind: "video", media: ["one"], metadata: { ...post.metadata, youtube: "remove-all" } };
const short = { ...video, youtubeShort: true };
// Publishes through a stand-in platform, recording what the media was prepared with and what reached the platform.
async function publishVideo(platform, job, { duration = 30 } = {}) {
  const seen = { options: undefined, infos: undefined, published: 0 };
  const result = await publish(
    { platform },
    job,
    fixture({
      process: async (_input, _output, options) => {
        seen.options = options;
        return options.vertical
          ? { kind: "video", width: 1080, height: 1920, duration, bytes: 8 }
          : { kind: "video", width: 1920, height: 1080, duration, bytes: 8 };
      },
      browser: async (_platform, _profile, _files, _post, infos) => {
        seen.published++;
        seen.infos = infos;
        return { url: "https://example.invalid/video" };
      },
    }),
  );
  return { ...seen, result };
}

test("a post marked as a Short is reframed for YouTube and no other destination", async () => {
  const youtube = await publishVideo("youtube", short);
  expect(youtube.options.vertical).toBe(true);
  expect(youtube.infos[0]).toMatchObject({ width: 1080, height: 1920 });
  expect(youtube.result.state).toBe("succeeded");
  const tiktok = await publishVideo("tiktok", short);
  expect(tiktok.options.vertical).toBe(false);
  expect(tiktok.infos[0]).toMatchObject({ width: 1920, height: 1080 });
});

test("a video not marked as a Short keeps its frame on YouTube, whatever its length", async () => {
  const youtube = await publishVideo("youtube", video, { duration: 600 });
  expect(youtube.options.vertical).toBe(false);
  expect(youtube.result.state).toBe("succeeded");
});

test("a Short over 3 minutes fails before publishing, so retrying is safe", async () => {
  const over = await publishVideo("youtube", short, { duration: 180.5 });
  expect(over.result.state).toBe("failed");
  expect(over.result.message).toContain("at most 3 minutes");
  expect(over.published).toBe(0);
  const limit = await publishVideo("youtube", short, { duration: 180 });
  expect(limit.result.state).toBe("succeeded");
  expect(limit.published).toBe(1);
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

test("Xiaohongshu publishes the Chinese version and every other destination the original", async () => {
  const video = {
    ...post,
    kind: "video",
    media: ["original"],
    metadata: { ...post.metadata, xiaohongshu: "remove-all" },
    variants: {
      xiaohongshu: { title: "短片", text: "正文", tags: [], video: "chinese" },
      tiktok: { title: "", text: "Text", tags: [] },
    },
  };
  for (const [platform, fetched] of [
    ["xiaohongshu", "media/chinese"],
    ["tiktok", "media/original"],
  ]) {
    const requests = [];
    const result = await publish(
      { platform },
      video,
      fixture({
        api: async (path) => {
          requests.push(path);
          return new Response("source");
        },
        browser: async (_platform, _dir, files) => {
          expect(files).toHaveLength(1);
          return { url: "https://example.invalid/fixture" };
        },
      }),
    );
    expect(result.state).toBe("succeeded");
    expect(requests).toEqual([fetched]);
  }
});

test("mixed posts process each item as what it is and publish them together", async () => {
  const processed = [];
  let args;
  await publish(
    { platform: "instagram" },
    { ...post, kind: "mixed", mediaKinds: ["photo", "video"] },
    fixture({
      process: async (_input, output, options) => {
        processed.push([options.kind, output.split(".").at(-1)]);
        await writeFile(output, "prepared");
        return { width: 64, height: 48, duration: 1, bytes: 8 };
      },
      python: async (_script, values) => {
        args = values;
        return { ok: true, url: "https://www.instagram.com/p/abc/" };
      },
    }),
  );
  expect(processed).toEqual([
    ["photo", "jpg"],
    ["video", "mp4"],
  ]);
  expect(args[args.indexOf("--kind") + 1]).toBe("mixed");
  expect(JSON.parse(args[args.indexOf("--media") + 1])).toHaveLength(2);
});

test("stopping ends an attempt at once, even one that ignores the signal", async () => {
  const stop = new AbortController();
  let seen;
  const running = publish(
    { platform: "tiktok" },
    { ...post, kind: "video", media: ["one"] },
    fixture({
      browser: (_platform, _profile, _files, _post, _infos, signal) => {
        seen = signal;
        return new Promise(() => {});
      },
      signal: stop.signal,
    }),
  );
  while (!seen) await new Promise((resolve) => setTimeout(resolve, 1));
  stop.abort();
  const result = await running;
  expect(seen).toBe(stop.signal);
  expect(result).toEqual({ state: "uncertain", message: "Stopped" });
});

test("stopping before anything is published leaves nothing to check", async () => {
  const stop = new AbortController();
  let published = false;
  const running = publish(
    { platform: "tiktok" },
    { ...post, kind: "video", media: ["one"] },
    fixture({
      process: (_input, _output, options) => {
        expect(options.signal).toBe(stop.signal);
        stop.abort();
        return new Promise(() => {});
      },
      browser: async () => {
        published = true;
      },
      signal: stop.signal,
    }),
  );
  expect(await running).toEqual({ state: "failed", message: "Stopped" });
  expect(published).toBe(false);
});

test("a confirmed post without a link warns against retrying", async () => {
  const result = await publish(
    { platform: "instagram" },
    post,
    fixture({ python: async () => ({ ok: true, message: "Published with video." }) }),
  );
  expect(result.state).toBe("uncertain");
  expect(result.message).toContain("Retrying would post it twice");
});

test("Instagram's new post is told from pinned and older ones by its shortcode", () => {
  const script = `
import json, sys
sys.path.insert(0, "scripts/publisher/vendor")
from browser_publish_verification import instagram_new_post_url as find, instagram_shortcode_time as at
new = "DfIUlhdSMIW"
started = at(new) - 60
links = ["/kualtx/p/DdRkPTeEWmQ/", "/kualtx/reel/" + new + "/", "/someone/reel/" + new + "/", "/kualtx/"]
print(json.dumps([round(at(new)), find(links, "kualtx", started), find(links, "kualtx", at(new) + 60), find(links, "other", started)]))
`;
  const run = Bun.spawnSync(["python3", "-c", script]);
  const [created, found, tooOld, otherAccount] = JSON.parse(run.stdout.toString());
  expect(new Date(created * 1000).toISOString().slice(0, 16)).toBe("2026-10-30T19:21");
  expect(found).toBe("https://www.instagram.com/reel/DfIUlhdSMIW/");
  expect(tooOld).toBeNull();
  expect(otherAccount).toBeNull();
});
const fetchesNothing = () => {
  throw new Error("must not run");
};
test.each(["farcaster", "lens"])("%s publishes with the prepared files and exactly its own version", async (platform) => {
  const calls = [];
  const adapter = async (files, infos, sent, options) => {
    calls.push({ files, infos, sent, options });
    return { url: `https://example.com/${platform}` };
  };
  const result = await publish(
    { platform },
    {
      ...post,
      variants: { [platform]: { title: "", text: "Their version", tags: ["film"] } },
      metadata: { [platform]: "remove-all" },
    },
    fixture({
      stateDir: "/state",
      farcaster: platform === "farcaster" ? adapter : fetchesNothing,
      lens: platform === "lens" ? adapter : fetchesNothing,
      atproto: fetchesNothing,
      browser: fetchesNothing,
      python: fetchesNothing,
    }),
  );
  expect(result).toEqual({ state: "succeeded", url: `https://example.com/${platform}`, message: "" });
  expect(calls[0].sent.caption).toBe("Their version");
  expect(calls[0].sent.tags).toEqual(["film"]);
  expect(calls[0].files).toHaveLength(2);
  expect(calls[0].options.stateDir).toBe("/state");
});
test("a refusal is a failure that can be retried; anything else during publishing stays unknown", async () => {
  const run = (error) =>
    publish(
      { platform: "farcaster" },
      { ...post, metadata: { farcaster: "remove-all" } },
      fixture({
        farcaster: async () => {
          throw error;
        },
      }),
    );
  expect(await run(Object.assign(new Error("Refused"), { rejected: true }))).toEqual({ state: "failed", message: "Refused" });
  expect(await run(new Error("socket hang up"))).toEqual({ state: "uncertain", message: "socket hang up" });
});
test("a cast the network hasn't shown yet is uncertain and keeps its link", async () => {
  const result = await publish(
    { platform: "farcaster" },
    { ...post, metadata: { farcaster: "remove-all" } },
    fixture({ farcaster: async () => ({ uncertain: true, url: "https://farcaster.xyz/x", message: "Check it" }) }),
  );
  expect(result).toEqual({ state: "uncertain", url: "https://farcaster.xyz/x", message: "Check it" });
});
