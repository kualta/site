import { isDeepStrictEqual } from "node:util";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { validateRecord } from "./atproto-validation.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const key = (uri) => uri.split("/").at(-1);

export async function coverBlob(cover) {
  const bytes = Buffer.from(cover.base64, "base64");
  return {
    $type: "blob",
    ref: { $link: CID.createV1(0x55, await sha256.digest(bytes)).toString() },
    mimeType: cover.mimeType,
    size: bytes.length,
  };
}

export async function listRecords(repo, did, collection) {
  const records = [];
  let cursor;
  do {
    const response = await repo.listRecords({ repo: did, collection, limit: 100, cursor });
    records.push(...response.data.records);
    cursor = response.data.cursor;
  } while (cursor);
  return records;
}

export async function verifyWebsite(manifest, fetcher = fetch) {
  const origin = manifest.publication.record.url;
  async function read(url) {
    const response = await fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Verification returned ${response.status}: ${url}`);
    return response.text();
  }
  const liveManifest = JSON.parse(await read(`${origin}/.well-known/site.standard.manifest.json`));
  if (!isDeepStrictEqual(liveManifest, manifest))
    throw new Error("Live deployment differs from this publishing snapshot; deploy it before syncing");
  const publication = await read(`${origin}/.well-known/site.standard.publication`);
  if (publication.trim() !== manifest.publication.uri) throw new Error("Publication verification mismatch");
  for (const document of manifest.documents) {
    const html = await read(`${origin}${document.record.path}`);
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    const tags = head.match(/<link\b[^>]*>/gi) ?? [];
    if (
      !tags.some((tag) => /\brel=["']site\.standard\.document["']/.test(tag) && tag.includes(`href="${document.uri}"`))
    ) {
      throw new Error(`Missing document verification: ${document.record.path}`);
    }
  }
}

export async function syncRecords(manifest, agent, { verifyOnly = false, log = console.log } = {}) {
  if (!verifyOnly && agent.did !== manifest.did) throw new Error("Authenticated identity does not match site owner");
  const repo = agent.com.atproto.repo;
  const publications = await listRecords(repo, manifest.did, "site.standard.publication");
  const documents = await listRecords(repo, manifest.did, "site.standard.document");
  const otherPublication = publications.find(
    (entry) =>
      entry.value.url?.replace(/\/$/, "") === manifest.publication.record.url && entry.uri !== manifest.publication.uri,
  );
  if (otherPublication)
    throw new Error(`Publication already exists at ${otherPublication.uri}; migrate its mapping before publishing`);
  const expected = new Set(manifest.documents.map((document) => document.uri));
  const stale = documents.filter((entry) => entry.value.site === manifest.publication.uri && !expected.has(entry.uri));
  if (stale.length)
    throw new Error(
      `Previously published articles were removed or made drafts. Explicitly remove their AT records before retrying: ${stale
        .map((entry) => entry.uri)
        .join(", ")}`,
    );
  for (const document of manifest.documents) {
    const duplicate = documents.find(
      (entry) =>
        entry.value.site === document.record.site &&
        entry.value.path === document.record.path &&
        entry.uri !== document.uri,
    );
    if (duplicate) throw new Error(`Article already exists at ${duplicate.uri}; migrate its mapping before publishing`);
  }

  async function put(item, existing, cover) {
    const collection = item.record.$type;
    if (
      existing &&
      (collection === "site.standard.publication"
        ? existing.value.url !== item.record.url
        : existing.value.site !== item.record.site || existing.value.path !== item.record.path)
    ) {
      throw new Error(`Record key belongs to different content: ${item.uri}`);
    }
    const record = { ...item.record };
    // Preserve social metadata owned by readers/integrations, not the MDX exporter.
    for (const field of ["bskyPostRef", "labels", "contributors", "links"]) {
      if (existing?.value[field] !== undefined) record[field] = existing.value[field];
    }
    if (cover) {
      record.coverImage = await coverBlob(cover);
    }
    validateRecord(record);
    if (isDeepStrictEqual(plain(existing?.value ?? null), plain(record))) {
      log(`Unchanged ${item.uri}`);
      return;
    }
    if (verifyOnly) throw new Error(`Remote article differs: ${item.uri}`);
    if (cover && !isDeepStrictEqual(plain(existing?.value.coverImage ?? null), record.coverImage)) {
      const upload = await repo.uploadBlob(Buffer.from(cover.base64, "base64"), { encoding: cover.mimeType });
      if (!isDeepStrictEqual(plain(upload.data.blob), record.coverImage))
        throw new Error(`Cover upload differs: ${item.uri}`);
    }
    await repo.putRecord({
      repo: manifest.did,
      collection,
      rkey: key(item.uri),
      record,
      swapRecord: existing?.cid ?? null,
      validate: false,
    });
    const readback = await repo.getRecord({ repo: manifest.did, collection, rkey: key(item.uri) });
    if (!isDeepStrictEqual(plain(readback.data.value), plain(record)))
      throw new Error(`Record readback differs: ${item.uri}`);
    log(`Published and verified ${item.uri}`);
  }
  await put(
    manifest.publication,
    publications.find((entry) => entry.uri === manifest.publication.uri),
  );
  for (const document of manifest.documents) {
    await put(
      document,
      documents.find((entry) => entry.uri === document.uri),
      document.cover,
    );
  }
}
