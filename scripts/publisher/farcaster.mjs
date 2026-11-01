import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CastType,
  FarcasterNetwork,
  MAX_KEY_TTL_SECONDS,
  Message,
  MessageType,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
  bytesToHexString,
  getFarcasterTime,
  hexStringToBytes,
  makeCastAdd,
  makeCastRemove,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemove,
  makeKeyRemoveBodySelfRevoke,
} from "@farcaster/core";
import { createPublicClient, http, parseAbi } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { openProfile } from "./browser.mjs";
import { createGrove, MAX_UPLOAD_BYTES } from "./grove.mjs";
import { linkPlaylist, makeHls } from "./hls.mjs";
import { deleteKey, readKey, rejected, saveKey, sleep } from "./protocol.mjs";

/** kualta's account. */
export const owner = 1075360;
// Writes need no API key on these; Neynar's nodes do, and a node that's down shouldn't stop a post.
export const nodes = ["https://haatz.quilibrium.com", "https://snap.farcaster.xyz:3381"];
const KEY = "farcaster";
const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b";
const options = { fid: owner, network: FarcasterNetwork.MAINNET };
const MEDIA_ORIGIN = "https://kualta.dev/m";

function unwrap(result) {
  if (result.isErr()) throw rejected(result.error.message);
  return result.value;
}
const toHex = (bytes) => unwrap(bytesToHexString(bytes));
const fromHex = (hex) => unwrap(hexStringToBytes(hex));
/** The first node that answers. A cast one node doesn't have comes back as null. */
async function read(path, fetcher) {
  let failure;
  for (const node of nodes) {
    try {
      const response = await fetcher(node + path, { signal: AbortSignal.timeout(20_000) });
      if (response.ok) return await response.json();
      if (/not ?found/i.test(await response.text())) return null;
      failure = new Error(`Farcaster node answered ${response.status}`);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
/**
 * Sends the same signed bytes to the next node when one is unavailable; the network treats a repeat as one message.
 * A 200 means valid and passed to the validators, not stored, so callers read the result back.
 */
async function submit(message, fetcher) {
  const body = Buffer.from(Message.encode(message).finish());
  let failure;
  for (const node of nodes) {
    try {
      const response = await fetcher(`${node}/v1/submitMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return;
      const text = await response.text();
      if (text.includes("bad_request.duplicate")) return;
      const reason = text.match(/bad_request\.[\w.]+\/[^"\\]+/)?.[0];
      if (reason?.includes("invalid signer"))
        throw rejected("Farcaster no longer accepts this laptop's key. Connect Farcaster again.");
      if (reason) throw rejected(`Farcaster refused the message: ${reason}`);
      failure = new Error(`Farcaster node answered ${response.status}`);
    } catch (error) {
      if (error.rejected) throw error;
      failure = error;
    }
  }
  throw failure;
}
async function loadSigner(stateDir) {
  const key = await readKey(stateDir, KEY);
  if (!key) throw rejected("Connect Farcaster in the composer first.");
  return new NobleEd25519Signer(fromHex(key));
}
const castExists = async (hash, fetcher) => Boolean(await read(`/v1/castById?fid=${owner}&hash=${hash}`, fetcher));
/** Reads a write back over about the time the network takes to store one. */
async function settled(check, wait) {
  for (const delay of [1000, 2000, 3000, 5000, 8000, 15_000, 30_000]) {
    await wait(delay);
    if (await check().catch(() => false)) return true;
  }
  return false;
}
/** A link pasted from the app has a short hash, and only the full one can be deleted or counted. */
async function fullHash(hash, fetcher) {
  if (hash.length === 42) return hash;
  let token = "";
  for (let page = 0; page < 20; page++) {
    const data = await read(`/v1/castsByFid?fid=${owner}&reverse=true&pageSize=100${token}`, fetcher);
    const found = data?.messages?.find((message) => message.hash.startsWith(hash));
    if (found) return found.hash;
    if (!data?.messages?.length || !data.nextPageToken) return null;
    token = `&pageToken=${encodeURIComponent(data.nextPageToken)}`;
  }
  return null;
}
/** One cast takes 320 bytes, a long one up to 1,024. */
export const castType = (text) =>
  new TextEncoder().encode(text).length <= 320 ? CastType.CAST : CastType.LONG_CAST;

/** Casts only embed URLs. The prepared copies go on Grove, the storage Lens uses, and casts link to them by way of this site. */
async function uploadEmbeds(files, infos, post, grove, makeStream, signal) {
  if (post.kind === "photo") {
    const urls = [];
    for (const file of files) {
      const { key } = await grove.upload(file, "image/jpeg");
      urls.push(`${MEDIA_ORIGIN}/${key}.jpg`);
    }
    return urls;
  }
  if (post.kind !== "video") return [];
  if (infos[0].bytes > MAX_UPLOAD_BYTES) throw rejected("Grove takes files up to 125 MB.");
  const stream = await makeStream(files[0], join(dirname(files[0]), "hls"), { signal });
  const segments = await grove.uploadAll(stream.segments, "video/mp2t");
  const segmentUrls = Object.fromEntries(stream.segments.map((path, i) => [path.split("/").at(-1), segments[i].url]));
  const media = await grove.uploadText(linkPlaylist(stream.media, segmentUrls), "application/vnd.apple.mpegurl");
  const master = await grove.uploadText(
    linkPlaylist(stream.master, { "media.m3u8": media.url }),
    "application/vnd.apple.mpegurl",
  );
  return [`${MEDIA_ORIGIN}/${master.key}.m3u8`];
}
export async function publishFarcaster(
  files,
  infos,
  post,
  { stateDir, signal, fetcher = fetch, wait = sleep, grove = createGrove(stateDir, `farcaster-${post.id}`), hls = makeHls },
) {
  const signer = await loadSigner(stateDir);
  let embeds;
  try {
    embeds = await uploadEmbeds(files, infos, post, grove, hls, signal);
  } catch (error) {
    await grove.remove().catch(() => {});
    // The post isn't out yet at any point during uploads.
    throw rejected(error.message);
  }
  const message = unwrap(
    await makeCastAdd(
      {
        text: post.caption,
        embeds: embeds.map((url) => ({ url })),
        embedsDeprecated: [],
        mentions: [],
        mentionsPositions: [],
        type: castType(post.caption),
      },
      options,
      signer,
    ),
  );
  await submit(message, fetcher);
  const hash = toHex(message.hash);
  const url = `https://farcaster.xyz/~/conversations/${hash}`;
  if (await settled(() => castExists(hash, fetcher), wait)) return { url };
  return {
    uncertain: true,
    url,
    message: "The network took the cast but hasn't shown it yet. Open its link before retrying.",
  };
}
export async function deleteCast(
  hash,
  { stateDir, publication, fetcher = fetch, wait = sleep, grove = createGrove(stateDir, `farcaster-${publication}`) },
) {
  const signer = await loadSigner(stateDir);
  const full = await fullHash(hash, fetcher);
  if (!full || !(await castExists(full, fetcher))) {
    await grove.remove().catch(() => {});
    return { state: "deleted", message: "Already removed from Farcaster" };
  }
  await submit(unwrap(await makeCastRemove({ targetHash: fromHex(full) }, options, signer)), fetcher);
  if (!(await settled(async () => !(await castExists(full, fetcher)), wait)))
    return { state: "uncertain", message: "The network took the removal but still shows the cast. Check it before retrying." };
  const leftover = await grove.remove().catch(() => true);
  return {
    state: "deleted",
    message: leftover ? "Deleted from Farcaster. Its media stays on Grove." : "Deleted from Farcaster",
  };
}
/** Likes, recasts and replies, counted from the network's own records; Farcaster has no view counts. */
export async function castMetrics(hash, { fetcher = fetch } = {}) {
  const full = await fullHash(hash, fetcher);
  if (!full) throw new Error("Cast not found");
  const count = async (path) => {
    const seen = new Set();
    let token = "";
    for (let page = 0; page < 50; page++) {
      const data = await read(`${path}&pageSize=100${token}`, fetcher);
      const before = seen.size;
      for (const message of data?.messages ?? []) seen.add(message.hash);
      // castsByParent's last token starts the list over instead of ending it.
      if (seen.size === before || !data.nextPageToken) break;
      token = `&pageToken=${encodeURIComponent(data.nextPageToken)}`;
    }
    return seen.size;
  };
  const reactions = `/v1/reactionsByCast?target_fid=${owner}&target_hash=${full}&reaction_type=`;
  return {
    likes: await count(`${reactions}Like`),
    shares: await count(`${reactions}Recast`),
    comments: await count(`/v1/castsByParent?fid=${owner}&hash=${full}`),
  };
}

const readCustody = () =>
  createPublicClient({ chain: optimism, transport: http() }).readContract({
    address: ID_REGISTRY,
    abi: parseAbi(["function custodyOf(uint256) view returns (address)"]),
    functionName: "custodyOf",
    args: [BigInt(owner)],
  });
const phrasePage = (custody) => `<!doctype html>
<meta charset="utf-8">
<title>Connect Farcaster</title>
<style>
  body { font: 16px/1.5 system-ui; margin: 10vh auto; max-width: 34rem; padding: 0 1rem; }
  code { overflow-wrap: anywhere; }
  input, button { font: inherit; padding: .5rem .75rem; }
  input { box-sizing: border-box; display: block; margin: 1rem 0; width: 100%; }
</style>
<h1>Connect Farcaster</h1>
<p>Farcaster adds a posting key only when the account's custody wallet signs for it. That wallet is
<code>${custody}</code>, and its recovery phrase is in the Farcaster app under Settings, Advanced.</p>
<p>The phrase signs once on this laptop and isn't stored or sent anywhere. The key it approves can only post and remove
casts, and this window closes when it's done.</p>
<form>
  <label for="phrase">Recovery phrase</label>
  <input id="phrase" type="password" autocomplete="off" autofocus required>
  <button>Approve the key</button>
</form>
<p id="status" role="status"></p>
<script>
  document.querySelector("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = document.getElementById("phrase");
    const status = document.getElementById("status");
    status.textContent = "Checking…";
    status.textContent = (await window.submitPhrase(input.value)) || "Signed. Return to the publisher.";
    input.value = "";
  });
</script>`;
/** In its own Chrome profile with no extensions and no page to reach it from, and the phrase goes straight to this process. */
export async function askRecoveryPhrase(custody, active, { stateDir, open = openProfile }) {
  const profile = join(stateDir, "farcaster-key-browser");
  const browser = await open(profile);
  let timer;
  try {
    const page = browser.pages()[0] || (await browser.newPage());
    return await new Promise((resolve, reject) => {
      const deadline = Date.now() + 10 * 60_000;
      timer = setInterval(() => {
        active()
          .then(() => {
            if (Date.now() > deadline) throw new Error("Connecting timed out. Connect again.");
            if (!browser.pages().length) throw new Error("The window closed. Connect again.");
          })
          .catch(reject);
      }, 2000);
      page
        .exposeFunction("submitPhrase", (phrase) => {
          let account;
          try {
            account = mnemonicToAccount(String(phrase).trim().toLowerCase().split(/\s+/).join(" "));
          } catch {
            return "That isn't a recovery phrase.";
          }
          if (account.address.toLowerCase() !== custody.toLowerCase())
            return `That phrase doesn't open ${custody}. Check the words and their order.`;
          resolve(account);
          return "";
        })
        .then(() => page.setContent(phrasePage(custody)))
        .catch(reject);
    });
  } finally {
    clearInterval(timer);
    await browser.close().catch(() => {});
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}
/**
 * Adds a gasless key: no transaction and no ETH, just one signature from the custody wallet. The key can only add and
 * remove casts, and lapses after 90 days without a post.
 */
export async function connectFarcaster(
  active,
  { stateDir, fetcher = fetch, wait = sleep, custodyOf = readCustody, ask = askRecoveryPhrase },
) {
  const custody = await custodyOf();
  const account = await ask(custody, active, { stateDir });
  await active();
  const seed = randomBytes(32);
  const signer = new NobleEd25519Signer(seed);
  const key = unwrap(await signer.getSignerKey());
  const signers = await read(`/v1/signersByFid?fid=${owner}`, fetcher);
  const body = unwrap(
    await makeKeyAddBody(
      {
        fid: BigInt(owner),
        key,
        scopes: [MessageType.CAST_ADD, MessageType.CAST_REMOVE],
        ttl: MAX_KEY_TTL_SECONDS,
        nonce: (signers?.currentUserNonce ?? 0) + 1,
        deadline: unwrap(getFarcasterTime()) + 60 * 60,
      },
      new ViemLocalEip712Signer(account),
    ),
  );
  await submit(unwrap(await makeKeyAdd(body, options, signer)), fetcher);
  const hex = toHex(key);
  const listed = async () => {
    await active();
    const current = await read(`/v1/signersByFid?fid=${owner}`, fetcher);
    return current?.signers?.some((item) => item.key === hex);
  };
  if (!(await settled(listed, wait))) throw new Error("Farcaster didn't list the new key. Connect again.");
  await saveKey(stateDir, KEY, toHex(seed));
}
/** The key revokes itself, so disconnecting needs no recovery phrase. The local copy goes even if the network can't be reached. */
export async function disconnectFarcaster({ stateDir, fetcher = fetch }) {
  try {
    const signer = await loadSigner(stateDir);
    const key = unwrap(await signer.getSignerKey());
    const signers = await read(`/v1/signersByFid?fid=${owner}`, fetcher);
    const nonce = (signers?.requesterFidNonces?.[owner] ?? 0) + 1;
    const body = unwrap(
      makeKeyRemoveBodySelfRevoke({ key, nonce, deadline: unwrap(getFarcasterTime()) + 60 * 60 }),
    );
    await submit(unwrap(await makeKeyRemove(body, options, signer)), fetcher);
  } catch (error) {
    console.warn(`Farcaster key not revoked: ${error.message}`);
  } finally {
    await deleteKey(stateDir, KEY);
  }
}
