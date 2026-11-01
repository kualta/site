import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custom, parseTransaction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  account,
  app,
  connectLens,
  deleteLensPost,
  disconnectLens,
  lensMetrics,
  publishLens,
  sendRequest,
} from "./lens.mjs";
import { readKey, saveKey } from "./protocol.mjs";

const KEY = generatePrivateKey();
const manager = privateKeyToAccount(KEY);
const HASH = "0x" + "ab".repeat(32);
const noWait = async () => {};
const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function state({ key = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "publisher-lens-"));
  dirs.push(dir);
  if (key) await saveKey(dir, "lens-manager", KEY);
  return dir;
}
/** The Lens API, answering each operation by name. */
function api(overrides = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    expect(String(url)).toBe("https://api.lens.xyz/graphql");
    const { query, variables } = JSON.parse(init.body);
    const name = query.match(/\{\s*(\w+)\s*\(request/)?.[1];
    calls.push({ name, variables, token: init.headers.Authorization });
    const answers = {
      challenge: { id: "challenge-id", text: "sign this" },
      authenticate: { __typename: "AuthenticationTokens", accessToken: "access" },
      post: variables.request.contentUri
        ? { __typename: "PostResponse", hash: HASH }
        : { slug: "abc123", id: "99", isDeleted: false },
      deletePost: { __typename: "DeletePostResponse", hash: HASH },
      transactionStatus: { __typename: "FinishedTransactionStatus" },
      ...overrides,
    };
    const answer = answers[name];
    if (answer instanceof Error) return Response.json({ data: null, errors: [{ message: answer.message }] });
    return Response.json({ data: { [name]: typeof answer === "function" ? answer(variables) : answer } });
  };
  return { fetcher, calls };
}
function fakeGrove() {
  let next = 0;
  const uploads = [];
  return {
    uploads,
    removed: 0,
    upload: async (path, type) => {
      uploads.push({ path, type });
      return { key: `k${next}`, uri: `lens://${next++}`, url: "https://api.grove.storage/x" };
    },
    uploadJson: async (value) => {
      uploads.push({ json: value });
      return { key: "meta", uri: "lens://metadata", url: "https://api.grove.storage/meta" };
    },
    async remove() {
      this.removed++;
      return false;
    },
  };
}
const textPost = { id: "job", kind: "text", caption: "Hello Lens", tags: ["film", "bogota"], media: [] };
const options = async (net, grove = fakeGrove(), extra = {}) => ({
  stateDir: await state(),
  fetcher: net.fetcher,
  wait: noWait,
  grove,
  poster: async (_input, output) => output,
  ...extra,
});

test("a text post logs in as the account's manager, stores its metadata, posts and links to it", async () => {
  const net = api();
  const grove = fakeGrove();
  const result = await publishLens([], [], textPost, await options(net, grove));
  const challenge = net.calls.find((call) => call.name === "challenge");
  expect(challenge.variables.request.accountManager).toEqual({ account, app, manager: manager.address });
  const metadata = grove.uploads.at(-1).json;
  expect(metadata.lens.mainContentFocus).toBe("TEXT_ONLY");
  expect(metadata.lens.content).toBe("Hello Lens");
  expect(metadata.lens.tags).toEqual(["film", "bogota"]);
  const post = net.calls.find((call) => call.variables.request.contentUri);
  expect(post.variables.request).toEqual({ contentUri: "lens://metadata" });
  expect(post.token).toBe("Bearer access");
  expect(result).toEqual({ url: "https://hey.xyz/posts/abc123" });
});
test("photos become one image post with the rest attached, each described", async () => {
  const grove = fakeGrove();
  await publishLens(
    ["/a.jpg", "/b.jpg"],
    [{}, {}],
    { ...textPost, kind: "photo", alts: ["first", ""], alt: "" },
    await options(api(), grove),
  );
  const { lens } = grove.uploads.at(-1).json;
  expect(lens.mainContentFocus).toBe("IMAGE");
  expect(lens.image).toEqual({ item: "lens://0", type: "image/jpeg", altTag: "first" });
  expect(lens.attachments).toEqual([{ item: "lens://1", type: "image/jpeg" }]);
});
test("a video carries its length, description and a poster frame", async () => {
  const grove = fakeGrove();
  await publishLens(
    ["/tmp/x/0.mp4"],
    [{ duration: 12.6, bytes: 10 }],
    { ...textPost, kind: "video", alt: "A scene" },
    await options(api(), grove),
  );
  expect(grove.uploads[0]).toEqual({ path: "/tmp/x/0.mp4", type: "video/mp4" });
  expect(grove.uploads[1]).toEqual({ path: "/tmp/x/poster.jpg", type: "image/jpeg" });
  const { lens } = grove.uploads.at(-1).json;
  expect(lens.mainContentFocus).toBe("VIDEO");
  expect(lens.video).toEqual({
    item: "lens://0",
    type: "video/mp4",
    cover: "lens://1",
    duration: 13,
    altTag: "A scene",
  });
});
test("a tag longer than Lens takes is left out instead of failing the post", async () => {
  const grove = fakeGrove();
  await publishLens([], [], { ...textPost, tags: ["film", "x".repeat(51)] }, await options(api(), grove));
  expect(grove.uploads.at(-1).json.lens.tags).toEqual(["film"]);
});
test.each(["SponsoredTransactionRequest", "SelfFundedTransactionRequest"])(
  "%s is sent with the manager's key",
  async (typename) => {
    const net = api({
      post: (variables) =>
        variables.request.contentUri ? { __typename: typename, raw: { from: manager.address } } : { slug: "abc123" },
    });
    const sent = [];
    const result = await publishLens(
      [],
      [],
      textPost,
      await options(net, fakeGrove(), {
        send: async (request, signer) => {
          sent.push({ request, signer });
          return HASH;
        },
      }),
    );
    expect(sent[0].request.__typename).toBe(typename);
    expect(sent[0].signer.address).toBe(manager.address);
    expect(result.url).toBe("https://hey.xyz/posts/abc123");
  },
);
test("a refusal from Lens means nothing went out", async () => {
  const net = api({ post: { __typename: "TransactionWillFail", reason: "Rules not met" } });
  const error = await publishLens([], [], textPost, await options(net)).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toBe("Rules not met");
});
test("a key that isn't a manager any more stops before uploading anything", async () => {
  const grove = fakeGrove();
  const net = api({ challenge: new Error("Forbidden - Signer is not a manager") });
  const error = await publishLens([], [], textPost, await options(net, grove)).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(grove.uploads).toHaveLength(0);
});
test("a failed transaction means nothing went out", async () => {
  const net = api({ transactionStatus: { __typename: "FailedTransactionStatus", reason: "reverted" } });
  const error = await publishLens([], [], textPost, await options(net)).catch((e) => e);
  expect(error.rejected).toBe(true);
});
test("a transaction still unindexed after the wait is uncertain, naming it", async () => {
  const net = api({ transactionStatus: { __typename: "PendingTransactionStatus" } });
  const result = await publishLens([], [], textPost, await options(net));
  expect(result.uncertain).toBe(true);
  expect(result.message).toContain(HASH);
});
test("a lost connection on the post itself isn't taken as a refusal: signless posts may have gone out", async () => {
  const net = api();
  const flaky = async (url, init) => {
    if (JSON.parse(init.body).variables.request.contentUri) throw new Error("socket hang up");
    return net.fetcher(url, init);
  };
  const error = await publishLens([], [], textPost, await options({ fetcher: flaky })).catch((e) => e);
  expect(error.message).toBe("socket hang up");
  expect(error.rejected).toBeUndefined();
});
test("failed uploads clear what they left and post nothing", async () => {
  const net = api();
  const grove = fakeGrove();
  grove.uploadJson = async () => {
    throw new Error("Grove is down");
  };
  const error = await publishLens([], [], textPost, await options(net, grove)).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(grove.removed).toBe(1);
  expect(net.calls.some((call) => call.variables.request.contentUri)).toBe(false);
});
test("publishing without a key asks to connect", async () => {
  const error = await publishLens([], [], textPost, {
    stateDir: await state({ key: false }),
    grove: fakeGrove(),
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toContain("Connect Lens");
});
const raw = {
  from: manager.address,
  to: account,
  nonce: 1,
  gasLimit: 800_000,
  maxFeePerGas: "3000000000",
  maxPriorityFeePerGas: "0",
  data: "0x",
  value: "0",
};
test("self-funded gas the key can't cover says how much and where to send it, before sending anything", async () => {
  const error = await sendRequest({ __typename: "SelfFundedTransactionRequest", raw }, manager, {
    balanceOf: async () => 0n,
  }).catch((e) => e);
  expect(error.rejected).toBe(true);
  expect(error.message).toContain("0.0024 GHO");
  expect(error.message).toContain(manager.address);
});
/** Signs for real and stops at the chain, keeping what would have been broadcast. */
function chain() {
  const sent = [];
  const transport = custom({
    request: async ({ method, params }) => {
      if (method === "eth_chainId") return "0xe8";
      if (method === "eth_sendRawTransaction") {
        sent.push(params[0]);
        return HASH;
      }
      throw new Error(`Unexpected ${method}`);
    },
  });
  return { sent, transport };
}
test("a sponsored request is signed as a zkSync transaction naming the paymaster", async () => {
  const { sent, transport } = chain();
  const paymaster = "0x" + "99".repeat(20);
  const hash = await sendRequest(
    {
      __typename: "SponsoredTransactionRequest",
      raw: { ...raw, customData: { paymasterParams: { paymaster, paymasterInput: "0x8c5a3445" } } },
    },
    manager,
    { transport },
  );
  expect(hash).toBe(HASH);
  expect(sent[0].slice(0, 4)).toBe("0x71");
  expect(sent[0]).toContain("99".repeat(20));
  expect(sent[0]).toContain(manager.address.slice(2).toLowerCase());
});
test("a self-funded request the key can pay for is an ordinary signed transaction", async () => {
  const { sent, transport } = chain();
  const hash = await sendRequest({ __typename: "SelfFundedTransactionRequest", raw }, manager, {
    transport,
    balanceOf: async () => 10n ** 18n,
  });
  expect(hash).toBe(HASH);
  expect(sent[0].slice(0, 4)).toBe("0x02");
  const parsed = parseTransaction(sent[0]);
  expect(parsed.chainId).toBe(232);
  expect(parsed.to).toBe(account.toLowerCase());
});
test("a request for another wallet is refused", async () => {
  const error = await sendRequest(
    { __typename: "SponsoredTransactionRequest", raw: { ...raw, from: account } },
    manager,
  ).catch((e) => e);
  expect(error.rejected).toBe(true);
});
test("connecting shows the address to add, waits until Lens accepts it, and keeps the key private", async () => {
  const dir = await state({ key: false });
  const net = api();
  let attempts = 0;
  const notYet = async (url, init) => {
    if (JSON.parse(init.body).query.includes("challenge(") && attempts++ < 2)
      return Response.json({ data: null, errors: [{ message: "Forbidden - Signer is not a manager" }] });
    return net.fetcher(url, init);
  };
  const reports = [];
  await connectLens(async () => {}, {
    stateDir: dir,
    fetcher: notYet,
    wait: noWait,
    report: async (message) => reports.push(message),
  });
  expect(attempts).toBe(3);
  const address = privateKeyToAccount(await readKey(dir, "lens-manager")).address;
  expect(reports[0]).toContain(address);
  expect(reports[0]).toContain("https://hey.xyz/settings/manager");
  expect((await stat(join(dir, "lens-manager.key"))).mode & 0o777).toBe(0o600);
});
test("connecting again keeps the same address, so it isn't added twice", async () => {
  const dir = await state();
  const reports = [];
  await connectLens(async () => {}, {
    stateDir: dir,
    fetcher: api().fetcher,
    wait: noWait,
    report: async (message) => reports.push(message),
  });
  expect(reports[0]).toContain(manager.address);
});
test("cancelling stops waiting", async () => {
  await expect(
    connectLens(
      async () => {
        throw new Error("Connection cancelled or expired");
      },
      { stateDir: await state(), fetcher: api().fetcher, wait: noWait, report: async () => {} },
    ),
  ).rejects.toThrow("cancelled");
});
test("disconnecting forgets the key", async () => {
  const dir = await state();
  await disconnectLens({ stateDir: dir });
  expect(await readKey(dir, "lens-manager")).toBeNull();
});
test("deleting removes the post, then its media", async () => {
  const net = api();
  const grove = fakeGrove();
  const result = await deleteLensPost("abc123", await options(net, grove));
  const removal = net.calls.find((call) => call.name === "deletePost");
  expect(removal.variables.request).toEqual({ post: "99" });
  expect(result).toEqual({ state: "deleted", message: "Deleted from Lens" });
  expect(grove.removed).toBe(1);
});
test("a post that's already gone counts as deleted", async () => {
  const net = api({ post: { id: "99", isDeleted: true } });
  const result = await deleteLensPost("abc123", await options(net));
  expect(result.state).toBe("deleted");
  expect(net.calls.some((call) => call.name === "deletePost")).toBe(false);
});
test("a removal not yet indexed stays uncertain and keeps the media", async () => {
  const net = api({ transactionStatus: { __typename: "PendingTransactionStatus" } });
  const grove = fakeGrove();
  const result = await deleteLensPost("abc123", await options(net, grove));
  expect(result.state).toBe("uncertain");
  expect(grove.removed).toBe(0);
});
test("metrics come from the post's public stats", async () => {
  const net = api({
    post: { isDeleted: false, stats: { comments: 2, reposts: 1, quotes: 3, reactions: 5, bookmarks: 4 } },
  });
  expect(await lensMetrics("abc123", { fetcher: net.fetcher })).toEqual({ likes: 5, comments: 2, shares: 4, saves: 4 });
});
test("metrics refuse a deleted post", async () => {
  const net = api({ post: { isDeleted: true, stats: { comments: 0, reposts: 0, quotes: 0, reactions: 0, bookmarks: 0 } } });
  await expect(lensMetrics("abc123", { fetcher: net.fetcher })).rejects.toThrow("Post not found");
});
