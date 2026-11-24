import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Lexicons, jsonToLex } from "@atproto/lexicon";
import { recordKey } from "../lib/atproto-content.mjs";
import { owner } from "./atproto.mjs";

export const collection = "dev.kualta.post";
const lexicons = new Lexicons([
  JSON.parse(readFileSync(new URL(`../lexicons/${collection}.json`, import.meta.url), "utf8")),
]);

/** A post's record key never changes, so writing its record again can only ever replace it. */
export const postRecordKey = (job) => recordKey(`publisher:post:${job}`);

const base32 = "abcdefghijklmnopqrstuvwxyz234567";
/** The address a PDS gives a blob with this SHA-256: a CIDv1 of raw bytes, in base32. */
export function blobCid(sha256) {
  const bytes = [0x01, 0x55, 0x12, 0x20, ...Buffer.from(sha256, "hex")];
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let cid = "b";
  for (let i = 0; i < bits.length; i += 5) cid += base32[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return cid;
}

const records = {
  bluesky: [/^https:\/\/bsky\.app\/profile\/(did:[a-z0-9:.-]+)\/post\/([a-z0-9]+)\/?$/i, "app.bsky.feed.post"],
  grain: [/^https:\/\/grain\.social\/profile\/(did:[a-z0-9:.-]+)\/gallery\/([a-z0-9]+)\/?$/i, "social.grain.gallery"],
};
/** The copy's own record, when its link names the repository by DID; a link by handle doesn't say which that is. */
function recordUri(platform, url) {
  if (!records[platform]) return;
  const [pattern, type] = records[platform];
  const match = url.match(pattern);
  return match ? `at://${match[1]}/${type}/${match[2]}` : undefined;
}

const feedPost = "app.bsky.feed.post";
const blob = (value) => value?.$type === "blob" && typeof value.ref?.$link === "string";
const described = ({ alt, aspectRatio }) => ({
  ...(alt ? { alt } : {}),
  ...(aspectRatio ? { aspectRatio: { width: aspectRatio.width, height: aspectRatio.height } } : {}),
});
/** The photos or video a Bluesky post's embed holds, as `media` items pointing at the same blobs. */
export function embedMedia(embed) {
  const held = embed?.$type === "app.bsky.embed.recordWithMedia" ? embed.media : embed;
  if (held?.$type === "app.bsky.embed.images")
    return held.images
      .filter((item) => blob(item.image))
      .map((item) => ({ $type: `${collection}#image`, image: item.image, ...described(item) }));
  if (held?.$type === "app.bsky.embed.video" && blob(held.video))
    return [{ $type: `${collection}#video`, video: held.video, ...described(held) }];
  return [];
}

/**
 * A post with the media its record may hold, or with `noMedia` saying why it holds none. A record can point at any
 * blob its repository stores, so the photos or video of the Bluesky copy that is up are reused as they are: nothing is
 * uploaded, and nothing is shown that the copy doesn't show already. The archive's uploads are never sent, since they
 * are the camera's files and nothing here can tell which of them a copy elsewhere shows.
 */
export async function withMedia({ media: _, ...source }, pds, fetcher = fetch) {
  const live = source.targets.filter((target) => !target.deleted);
  if (!live.length || source.post.kind === "text") return source;
  const prefix = `at://${owner}/${feedPost}/`;
  const posts = live
    .map((target) => recordUri(target.platform, target.url))
    .filter((uri) => uri?.startsWith(prefix))
    .map((uri) => uri.slice(prefix.length));
  if (!posts.length)
    return {
      ...source,
      noMedia: `no Bluesky copy is up, and the archive's uploads can't be shown to match what ${live
        .map((target) => target.platform)
        .join(", ")} shows`,
    };
  let found = false;
  for (const rkey of posts) {
    const post = await readRecord(pds, feedPost, rkey, fetcher);
    const media = embedMedia(post?.value.embed);
    if (media.length) return { ...source, media };
    found ||= !!post;
  }
  return {
    ...source,
    noMedia: found ? "the Bluesky copy holds no photos or video" : "the Bluesky copy is gone from the repository",
  };
}

/**
 * The record a post should have, or null when none of its copies is up. Each field is taken by name, from what the
 * site says the copies that are up show (`src/lib/publisher/post-records.ts`); nothing else a post holds is public.
 */
export function buildPostRecord({ post, targets, thumbnail, media, created_at }) {
  const live = targets.filter((target) => !target.deleted);
  if (!live.length) return null;
  // Deleted copies count, so taking the first one down doesn't move the post's date.
  const published = targets.filter((target) => target.published_at).map((target) => target.published_at);
  return {
    $type: collection,
    kind: post.kind,
    ...(post.title ? { title: post.title } : {}),
    text: post.text,
    ...(post.tags?.length ? { tags: post.tags } : {}),
    createdAt: new Date(published.length ? Math.min(...published) : created_at).toISOString(),
    ...(thumbnail
      ? {
          thumbnail: {
            $type: "blob",
            ref: { $link: blobCid(thumbnail.sha256) },
            mimeType: thumbnail.type,
            size: thumbnail.size,
          },
        }
      : {}),
    ...(media?.length ? { media } : {}),
    syndication: live.map((target) => {
      const uri = recordUri(target.platform, target.url);
      return {
        platform: target.platform,
        url: target.url,
        ...(uri ? { uri } : {}),
        ...(target.published_at ? { publishedAt: new Date(target.published_at).toISOString() } : {}),
      };
    }),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * What to do to a post's record, given the one in the repository (`{ cid, value }`, or nothing). `upload` says the
 * thumbnail's blob isn't the one the record already holds, so it has to go up first.
 */
export function planPostRecord(source, existing) {
  const plan = { job: source.id, rkey: postRecordKey(source.id), cid: existing?.cid };
  let record = buildPostRecord(source);
  if (!record) return { ...plan, action: existing ? "delete" : "none" };
  const held = existing?.value.thumbnail;
  const upload = !!record.thumbnail && held?.ref?.$link !== record.thumbnail.ref.$link;
  // The PDS may describe the same bytes its own way; its description is the one to keep.
  if (record.thumbnail && !upload) record = { ...record, thumbnail: held };
  if (existing && same(record, existing.value)) return { ...plan, action: "none" };
  return { ...plan, action: existing ? "update" : "create", record, upload };
}

export const RELINK =
  "The Bluesky sign-in doesn't allow writing dev.kualta.post records. Re-link Bluesky in the publisher Accounts tab " +
  "(disconnect Grain / Bluesky, then connect it again), then run: bun run publisher post-records --write";
export class ScopeError extends Error {
  constructor() {
    super(RELINK);
  }
}
const grants = (scope) => scope.split(" ").some((part) => part.split("?")[0] === `repo:${collection}`);
/** Whether the PDS turned a write down for want of permission, however it words it. */
export function scopeDenied(error) {
  const text = `${error?.error ?? ""} ${error?.message ?? ""}`;
  return (
    /ScopeMissing|insufficient_scope|InsufficientScope/i.test(text) ||
    ([401, 403].includes(error?.status) && /scope/i.test(text))
  );
}

const ascii = (bytes, at, length) => String.fromCharCode(...bytes.subarray(at, at + length));
/**
 * Whether an image carries EXIF, XMP, IPTC or a comment, where a camera or an editor puts the place, time and author. The composer's thumbnails are drawn
 * afresh and have none, but the site stores whatever it is sent, and a blob in the repository is public for good.
 */
export function carriesMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    // Segments up to the image data: APP1 holds both; APP13 holds IPTC and COM a free comment, refused whatever they say.
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xff && bytes[at + 1] !== 0xda; ) {
      if (bytes[at + 1] === 0xed || bytes[at + 1] === 0xfe) return true;
      if (bytes[at + 1] === 0xe1 && /^(Exif|http:\/\/ns\.adobe\.com\/)/.test(ascii(bytes, at + 4, 28))) return true;
      at += 2 + view.getUint16(at + 2);
    }
    return false;
  }
  if (ascii(bytes, 1, 3) === "PNG") {
    for (let at = 8; at + 8 <= bytes.length; at += 12 + view.getUint32(at)) {
      const type = ascii(bytes, at + 4, 4);
      if (type === "eXIf") return true;
      if (/^(iTXt|tEXt|zTXt)$/.test(type) && /^(XML:com\.adobe\.xmp|Raw profile type)/.test(ascii(bytes, at + 8, 17)))
        return true;
    }
    return false;
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    for (let at = 12; at + 8 <= bytes.length; ) {
      if (["EXIF", "XMP "].includes(ascii(bytes, at, 4))) return true;
      const size = view.getUint32(at + 4, true);
      at += 8 + size + (size % 2);
    }
    return false;
  }
  throw new Error("The post's thumbnail is not a JPEG, PNG or WebP image");
}

const xrpc = (pds, method, query) => new URL(`/xrpc/com.atproto.repo.${method}?${new URLSearchParams(query)}`, pds);
/** A record as the owner's repository holds it now. Records are public, so reading one takes no sign-in. */
async function readRecord(pds, collection, rkey, fetcher) {
  const response = await fetcher(xrpc(pds, "getRecord", { repo: owner, collection, rkey }), {
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok) return { cid: data.cid, value: data.value };
  if (data.error === "RecordNotFound") return null;
  throw new Error(`The repository could not be read (${response.status}${data.message ? `: ${data.message}` : ""})`);
}
export const readPostRecord = (pds, rkey, fetcher = fetch) => readRecord(pds, collection, rkey, fetcher);
export async function listPostRecords(pds, fetcher = fetch) {
  const found = new Map();
  let cursor;
  do {
    const response = await fetcher(
      xrpc(pds, "listRecords", { repo: owner, collection, limit: "100", ...(cursor ? { cursor } : {}) }),
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok) throw new Error(`The repository could not be read (${response.status})`);
    const data = await response.json();
    for (const record of data.records) found.set(record.uri.split("/").pop(), { cid: record.cid, value: record.value });
    cursor = data.records.length ? data.cursor : undefined;
  } while (cursor);
  return found;
}
export async function resolvePds(fetcher = fetch) {
  const response = await fetcher(`https://plc.directory/${owner}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The identity directory could not be read (${response.status})`);
  const pds = (await response.json()).service?.find((service) => service.type === "AtprotoPersonalDataServer");
  if (!pds || new URL(pds.serviceEndpoint).protocol !== "https:") throw new Error("Identity has no HTTPS PDS");
  return new URL(pds.serviceEndpoint);
}

/**
 * Carries a plan out. Each write names the version it replaces, or creates under the post's fixed key, so a write
 * whose answer was lost can't leave a second record or undo a newer one: the next plan starts from what is there.
 */
export async function applyPostRecord(plan, source, { authorization, api }) {
  if (plan.action === "none") return;
  const { agent, scope } = authorization;
  if (agent.did !== owner) throw new Error("The AT Protocol account must belong to kualta");
  if (typeof scope === "string" && !grants(scope)) throw new ScopeError();
  const at = { repo: owner, collection, rkey: plan.rkey };
  try {
    if (plan.action === "delete") {
      await agent.com.atproto.repo.deleteRecord({ ...at, swapRecord: plan.cid });
      return;
    }
    lexicons.assertValidRecord(collection, jsonToLex(plan.record));
    let record = plan.record;
    if (plan.upload) {
      const bytes = new Uint8Array(await (await api(`post-records/${plan.job}/thumbnail`)).arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== source.thumbnail.sha256)
        throw new Error("The post's thumbnail changed meanwhile");
      if (carriesMetadata(bytes)) throw new Error("The post's thumbnail carries EXIF, XMP, IPTC or comment metadata");
      const { data } = await agent.uploadBlob(bytes, { encoding: source.thumbnail.type });
      record = { ...record, thumbnail: data.blob };
    }
    // The PDS has no copy of this schema to check against; the record was checked above.
    if (plan.action === "create") await agent.com.atproto.repo.createRecord({ ...at, validate: false, record });
    else await agent.com.atproto.repo.putRecord({ ...at, validate: false, swapRecord: plan.cid, record });
  } catch (error) {
    throw scopeDenied(error) ? new ScopeError() : error;
  }
}

const label = (source) => JSON.stringify((source.post.title || source.post.text).slice(0, 50));
const where = (source) =>
  source.targets
    .filter((target) => !target.deleted)
    .map((target) => target.platform)
    .join(", ");

/**
 * Brings every post's record, or one post's, in step with what is published. Without `authorization` nothing is
 * written and each line says what would be. Running it again does nothing more, so it is also the backfill for posts
 * from before records existed and the repair after a failed write.
 */
export async function reconcilePostRecords({ api, job, authorization, fetcher = fetch, log = console.log }) {
  const pds = authorization?.pdsUrl ?? (await resolvePds(fetcher));
  const sources = [];
  if (job) {
    const { job: source } = await (await api(`post-records/${job}`)).json();
    if (!source) throw new Error(`No post ${job}`);
    sources.push(source);
  } else {
    let before;
    do {
      const page = await (await api(`post-records${before ? `?before=${before}` : ""}`)).json();
      sources.push(...page.jobs);
      before = page.next;
    } while (before);
  }
  const existing = job
    ? new Map([[postRecordKey(job), await readPostRecord(pds, postRecordKey(job), fetcher)]])
    : await listPostRecords(pds, fetcher);
  const counts = { create: 0, update: 0, delete: 0, none: 0, failed: 0, orphans: 0 };
  for (const bare of sources) {
    const rkey = postRecordKey(bare.id);
    const held = existing.get(rkey);
    existing.delete(rkey);
    let source;
    try {
      source = await withMedia(bare, pds, fetcher);
    } catch (error) {
      // Planning without its media would take the media off the record.
      counts.failed++;
      log(`FAILED ${rkey} ${bare.id}: ${error.message}`);
      continue;
    }
    if (source.noMedia) log(`no media for ${rkey} ${source.id} ${label(source)}: ${source.noMedia}`);
    const plan = planPostRecord(source, held);
    if (plan.action === "none") {
      counts.none++;
      continue;
    }
    const line = plan.record
      ? `${plan.action} ${plan.rkey} ${source.id} ${label(source)} → ${where(source)}`
      : `${plan.action} ${plan.rkey} ${source.id}`;
    if (!authorization) {
      counts[plan.action]++;
      log(`would ${line}`);
      continue;
    }
    try {
      await applyPostRecord(plan, source, { authorization, api });
      counts[plan.action]++;
      log(line);
    } catch (error) {
      // Every other write would be turned down the same way.
      if (error instanceof ScopeError) throw error;
      counts.failed++;
      log(`FAILED ${line}: ${error.message}`);
    }
  }
  // A record no post accounts for is left alone: a short answer from the site must never empty the collection.
  for (const rkey of existing.keys()) {
    counts.orphans++;
    log(`no post for record ${rkey}; left alone`);
  }
  return counts;
}

let relinkShown = false;
/**
 * Reconciles one post's record after a copy of it went up or came down. It never throws and never reports the
 * platform's own result differently: the copy is already up, or gone, whatever happens to the record. The queue waits
 * on it, so a repository that doesn't answer is given up on.
 */
export async function syncPostRecord(job, { api, oauth, fetcher = fetch, log = console.error, deadline = 60_000 }) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`no answer within ${deadline / 1000} s, though the write may still land`)),
      deadline,
    );
  });
  const work = (async () => {
    const { job: bare } = await (await api(`post-records/${job}`)).json();
    if (!bare) return "none";
    const authorization = await oauth.agent();
    const source = await withMedia(bare, authorization.pdsUrl, fetcher);
    const plan = planPostRecord(source, await readPostRecord(authorization.pdsUrl, postRecordKey(job), fetcher));
    await applyPostRecord(plan, source, { authorization, api });
    if (plan.action !== "none") log(`Post record ${plan.rkey}: ${plan.action}`);
    return plan.action;
  })();
  // Given up on, it may still fail later with nobody waiting.
  work.catch(() => {});
  try {
    return await Promise.race([work, late]);
  } catch (error) {
    if (!(error instanceof ScopeError))
      log(
        `Post record for ${job} was NOT written: ${error.message}. Repair it with: bun run publisher post-records --write`,
      );
    else if (!relinkShown) {
      relinkShown = true;
      log(`Post records are NOT being written. ${RELINK}`);
    }
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}
