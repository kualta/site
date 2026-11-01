import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CastType,
  Message,
  MessageType,
  bytesToHexString,
  hexStringToBytes,
  verifyKeyAdd,
} from "@farcaster/core";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import {
  askRecoveryPhrase,
  castMetrics,
  castType,
  connectFarcaster,
  deleteCast,
  disconnectFarcaster,
  nodes,
  owner,
  publishFarcaster,
} from "./farcaster.mjs";
import { readKey, saveKey } from "./protocol.mjs";

const SEED = "0x" + "11".repeat(32);
const noWait = async () => {};
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function state({ key = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "publisher-farcaster-"));
  dirs.push(dir);
  if (key) await saveKey(dir, "farcaster", SEED);
  return dir;
}
const hex = (bytes) => bytesToHexString(bytes)._unsafeUnwrap();

/** A node that stores what it's sent. */
function network({ refuse, down = [], casts = new Set(), store = true, signers = [], nonce = 0, routes = {} } = {}) {
  const sent = [];
  const fetcher = async (url, init = {}) => {
    const { origin, pathname, search } = new URL(url);
    if (down.includes(origin)) return new Response("mempool channel is full", { status: 503 });
    if (pathname === "/v1/submitMessage") {
      const message = Message.decode(new Uint8Array(init.body));
      sent.push({ origin, message, bytes: Buffer.from(init.body).toString("hex") });
      if (refuse) return Response.json({ error_detail: `message: "${refuse}", details` }, { status: 400 });
      if (store) {
        if (message.data.type === MessageType.CAST_ADD) casts.add(hex(message.hash));
        if (message.data.type === MessageType.CAST_REMOVE) casts.delete(hex(message.data.castRemoveBody.targetHash));
        if (message.data.type === MessageType.KEY_ADD) signers.push({ key: hex(message.data.keyAddBody.key) });
      }
      return Response.json({});
    }
    if (pathname === "/v1/castById") {
      const hash = new URLSearchParams(search).get("hash");
      return casts.has(hash) ? Response.json({ hash }) : new Response('{"error_detail":"cast not found"}', { status: 400 });
    }
    if (pathname === "/v1/signersByFid") return Response.json({ signers, currentUserNonce: nonce });
    const route = routes[pathname];
    if (route) return Response.json(route(new URLSearchParams(search)));
    return new Response("unexpected", { status: 500 });
  };
  return { fetcher, sent, casts, signers };
}
function fakeGrove({ fail } = {}) {
  let next = 0;
  const texts = [];
  const key = () => String(next++).padStart(64, "a");
  const made = () => {
    const k = key();
    return { key: k, uri: `lens://${k}`, url: `https://api.grove.storage/${k}` };
  };
  return {
    texts,
    removed: 0,
    upload: async () => {
      if (fail) throw new Error(fail);
      return made();
    },
    uploadAll: async (paths) => paths.map(made),
    uploadText: async (text) => {
      texts.push(text);
      return made();
    },
    async remove() {
      this.removed++;
      return false;
    },
  };
}
const textPost = { id: "job", kind: "text", caption: "Hello Farcaster", media: [] };

test("a text post is one cast, signed for the owner, read back before it counts", async () => {
  const net = network();
  const result = await publishFarcaster([], [], textPost, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  });
  const { message } = net.sent[0];
  expect(net.sent).toHaveLength(1);
  expect(message.data.fid).toBe(owner);
  expect(message.data.castAddBody.text).toBe("Hello Farcaster");
  expect(message.data.castAddBody.type).toBe(CastType.CAST);
  expect(result).toEqual({ url: `https://farcaster.xyz/~/conversations/${hex(message.hash)}` });
});
test("text past 320 bytes goes as a long cast, counted in bytes", () => {
  expect(castType("x".repeat(320))).toBe(CastType.CAST);
  expect(castType("x".repeat(321))).toBe(CastType.LONG_CAST);
  expect(castType("空".repeat(107))).toBe(CastType.LONG_CAST);
});
test("a long caption builds a cast the library accepts", async () => {
  const net = network();
  await publishFarcaster([], [], { ...textPost, caption: "x".repeat(1024) }, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  });
  expect(net.sent[0].message.data.castAddBody.type).toBe(CastType.LONG_CAST);
});
test("photos embed links on this site that end in a file extension", async () => {
  const net = network();
  const dir = await state();
  const grove = fakeGrove();
  await publishFarcaster(["/a.jpg", "/b.jpg"], [{}, {}], { ...textPost, kind: "photo" }, {
    stateDir: dir,
    fetcher: net.fetcher,
    wait: noWait,
    grove,
  });
  const urls = net.sent[0].message.data.castAddBody.embeds.map((embed) => embed.url);
  expect(urls).toHaveLength(2);
  for (const url of urls) expect(url).toMatch(/^https:\/\/kualta\.dev\/m\/a*\d+\.jpg$/);
});
test("a video embeds an HLS playlist whose files all resolve on Grove", async () => {
  const net = network();
  const grove = fakeGrove();
  const hls = async () => ({
    segments: ["/tmp/x/0000.ts", "/tmp/x/0001.ts"],
    media: "#EXTM3U\n#EXTINF:6,\n0000.ts\n#EXTINF:6,\n0001.ts\n#EXT-X-ENDLIST\n",
    master: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=64x48,CODECS="avc1.640028"\nmedia.m3u8\n',
  });
  await publishFarcaster(["/tmp/x.mp4"], [{ bytes: 10 }], { ...textPost, kind: "video" }, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove,
    hls,
  });
  const [{ url }] = net.sent[0].message.data.castAddBody.embeds;
  expect(url).toMatch(/^https:\/\/kualta\.dev\/m\/[a\d]{64}\.m3u8$/);
  expect(grove.texts[0]).toContain("https://api.grove.storage/");
  expect(grove.texts[0]).not.toContain("0000.ts");
  expect(grove.texts[1]).toContain("https://api.grove.storage/");
  expect(grove.texts[1]).toContain("RESOLUTION=64x48");
  expect(grove.texts[1]).not.toContain("media.m3u8");
});
test("a video too big for Grove stops before anything is sent", async () => {
  const net = network();
  const error = await publishFarcaster(["/x.mp4"], [{ bytes: 126_000_000 }], { ...textPost, kind: "video" }, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(net.sent).toHaveLength(0);
});
test("a refused key says to reconnect and doesn't try other nodes", async () => {
  const net = network({ refuse: "bad_request.validation_failure/invalid signer" });
  const error = await publishFarcaster([], [], textPost, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toContain("Connect Farcaster again");
  expect(net.sent).toHaveLength(1);
});
test("a node that's down passes the same signed bytes to the next", async () => {
  const net = network({ down: [new URL(nodes[0]).origin] });
  const result = await publishFarcaster([], [], textPost, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  });
  expect(net.sent.map((item) => item.origin)).toEqual([new URL(nodes[1]).origin]);
  expect(result.url).toContain("/~/conversations/0x");
});
test("every node failing leaves the outcome unknown instead of claiming it wasn't posted", async () => {
  const net = network({ down: nodes.map((node) => new URL(node).origin) });
  const error = await publishFarcaster([], [], textPost, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  }).catch((e) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.rejected).toBeUndefined();
});
test("a cast the network never shows is uncertain, with its link to check", async () => {
  const net = network({ store: false });
  const result = await publishFarcaster([], [], textPost, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  });
  expect(result.uncertain).toBe(true);
  expect(result.url).toContain(hex(net.sent[0].message.hash));
});
test("a failed upload sends nothing and clears what it uploaded", async () => {
  const net = network();
  const grove = fakeGrove({ fail: "Grove is down" });
  const error = await publishFarcaster(["/a.jpg"], [{}], { ...textPost, kind: "photo" }, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove,
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toBe("Grove is down");
  expect(net.sent).toHaveLength(0);
  expect(grove.removed).toBe(1);
});
test("publishing without a key asks to connect", async () => {
  const error = await publishFarcaster([], [], textPost, {
    stateDir: await state({ key: false }),
    grove: fakeGrove(),
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toContain("Connect Farcaster");
});

const connectWith = async (dir, net, active = async () => {}) => {
  const custody = mnemonicToAccount(generateMnemonic(english));
  await connectFarcaster(active, {
    stateDir: dir,
    fetcher: net.fetcher,
    wait: noWait,
    custodyOf: async () => custody.address,
    ask: async () => custody,
  });
  return custody;
};
test("connecting adds a key limited to casts, signed by custody, and keeps it private", async () => {
  const dir = await state({ key: false });
  const net = network({ nonce: 4 });
  const custody = await connectWith(dir, net);
  const { message } = net.sent[0];
  const body = message.data.keyAddBody;
  expect(message.data.type).toBe(MessageType.KEY_ADD);
  expect(body.scopes).toEqual([MessageType.CAST_ADD, MessageType.CAST_REMOVE]);
  expect(body.nonce).toBe(5);
  expect(body.ttl).toBe(90 * 24 * 60 * 60);
  const verified = await verifyKeyAdd(
    {
      fid: BigInt(owner),
      key: body.key,
      keyType: body.keyType,
      scopes: body.scopes,
      ttl: body.ttl,
      nonce: body.nonce,
      deadline: BigInt(body.deadline),
    },
    body.custodySignature,
    hexStringToBytes(custody.address)._unsafeUnwrap(),
  );
  expect(verified.isOk() && verified.value).toBe(true);
  expect(await readKey(dir, "farcaster")).toMatch(/^0x[a-f\d]{64}$/);
  expect((await stat(join(dir, "farcaster.key"))).mode & 0o777).toBe(0o600);
});
test("a key the network never lists isn't saved", async () => {
  const dir = await state({ key: false });
  const net = network({ store: false });
  await expect(connectWith(dir, net)).rejects.toThrow("didn't list the new key");
  expect(await readKey(dir, "farcaster")).toBeNull();
});
test("cancelling after the phrase stops before the key is sent", async () => {
  const dir = await state({ key: false });
  const net = network();
  await expect(
    connectWith(dir, net, async () => {
      throw new Error("Connection cancelled or expired");
    }),
  ).rejects.toThrow("cancelled");
  expect(net.sent).toHaveLength(0);
});
test("the recovery phrase window only accepts the custody wallet's phrase, then closes and clears up", async () => {
  const phrase = generateMnemonic(english);
  const custody = mnemonicToAccount(phrase);
  const dir = await state({ key: false });
  let submit;
  let closed = false;
  let html = "";
  const page = {
    exposeFunction: async (_name, fn) => {
      submit = fn;
    },
    setContent: async (content) => {
      html = content;
    },
  };
  const browser = {
    pages: () => [page],
    close: async () => {
      closed = true;
    },
  };
  const pending = askRecoveryPhrase(custody.address, async () => {}, { stateDir: dir, open: async () => browser });
  while (!html) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(html).toContain(custody.address);
  expect(await submit(generateMnemonic(english))).toContain("doesn't open");
  expect(closed).toBe(false);
  expect(await submit(`  ${phrase.toUpperCase().replaceAll(" ", "  ")}\n`)).toBe("");
  expect((await pending).address).toBe(custody.address);
  expect(closed).toBe(true);
});
test("disconnecting revokes the key by itself and forgets it", async () => {
  const dir = await state();
  const net = network();
  await disconnectFarcaster({ stateDir: dir, fetcher: net.fetcher });
  expect(net.sent[0].message.data.type).toBe(MessageType.KEY_REMOVE);
  expect(await readKey(dir, "farcaster")).toBeNull();
});
test("disconnecting forgets the key even when the network can't be reached", async () => {
  const dir = await state();
  await disconnectFarcaster({
    stateDir: dir,
    fetcher: async () => {
      throw new Error("offline");
    },
  });
  expect(await readKey(dir, "farcaster")).toBeNull();
});

const FULL = "0xb379b21f150211f01be6796ad87879d3a9b74579";
test("deleting finds a short link's full hash, removes the cast, then its media", async () => {
  const casts = new Set([FULL]);
  const net = network({
    casts,
    routes: { "/v1/castsByFid": () => ({ messages: [{ hash: FULL }], nextPageToken: "" }) },
  });
  const grove = fakeGrove();
  const result = await deleteCast(FULL.slice(0, 10), {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove,
  });
  expect(hex(net.sent[0].message.data.castRemoveBody.targetHash)).toBe(FULL);
  expect(result).toEqual({ state: "deleted", message: "Deleted from Farcaster" });
  expect(grove.removed).toBe(1);
});
test("a cast that's already gone counts as deleted, with nothing sent", async () => {
  const net = network();
  const result = await deleteCast(FULL, {
    stateDir: await state(),
    fetcher: net.fetcher,
    wait: noWait,
    grove: fakeGrove(),
  });
  expect(result.state).toBe("deleted");
  expect(net.sent).toHaveLength(0);
});
test("a removal the network doesn't show stays uncertain and keeps the media", async () => {
  const net = network({ casts: new Set([FULL]), store: false });
  const grove = fakeGrove();
  const result = await deleteCast(FULL, { stateDir: await state(), fetcher: net.fetcher, wait: noWait, grove });
  expect(result.state).toBe("uncertain");
  expect(grove.removed).toBe(0);
});
test("media Grove keeps is said out loud", async () => {
  const casts = new Set([FULL]);
  const net = network({ casts });
  const grove = { ...fakeGrove(), remove: async () => true };
  const result = await deleteCast(FULL, { stateDir: await state(), fetcher: net.fetcher, wait: noWait, grove });
  expect(result).toEqual({ state: "deleted", message: "Deleted from Farcaster. Its media stays on Grove." });
});
test("metrics count every page of likes and recasts", async () => {
  const net = network({
    routes: {
      "/v1/reactionsByCast": (params) =>
        params.get("reaction_type") === "Like"
          ? params.get("pageToken")
            ? { messages: [{ hash: "c" }], nextPageToken: "" }
            : { messages: [{ hash: "a" }, { hash: "b" }], nextPageToken: "more" }
          : { messages: [{ hash: "d" }], nextPageToken: "" },
      "/v1/castsByParent": () => ({ messages: [], nextPageToken: "" }),
    },
  });
  expect(await castMetrics(FULL, { fetcher: net.fetcher })).toEqual({ likes: 3, shares: 1, comments: 0 });
});
test("replies aren't counted again when the node's last page token starts the list over", async () => {
  const net = network({
    routes: {
      "/v1/reactionsByCast": () => ({ messages: [], nextPageToken: "" }),
      "/v1/castsByParent": () => ({
        messages: [{ hash: "a" }, { hash: "b" }, { hash: "c" }],
        nextPageToken: "W251bGwsbnVsbF0=",
      }),
    },
  });
  expect((await castMetrics(FULL, { fetcher: net.fetcher })).comments).toBe(3);
});
