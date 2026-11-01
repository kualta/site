import { StorageClient, walletOnly } from "@lens-chain/storage-client";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ethereumKey } from "./protocol.mjs";

/** Grove refuses larger uploads. */
export const MAX_UPLOAD_BYTES = 125_000_000;
const LENS_CHAIN = 232;
const UPLOADS_AT_ONCE = 4;

/**
 * One publication's files on Grove, the public storage Lens uses. Each is owned by a key only this laptop has, and a
 * list of them is kept beside it, so deleting the post can remove what it put there.
 *
 * Files serve as soon as they're uploaded, but Grove reports them "available" and never "done", so waiting for that
 * would hang. It also answers "could not find resource" when asked to delete them, so for now they stay; the list and
 * the ownership are what would let them be removed once it doesn't.
 */
export function createGrove(stateDir, publication, { client = StorageClient.create() } = {}) {
  const manifest = join(stateDir, "grove", `${publication}.json`);
  const acl = async () => walletOnly((await ethereumKey(stateDir, "grove")).address, LENS_CHAIN);
  const saved = async () => {
    try {
      return JSON.parse(await readFile(manifest, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  // Uploads finish in any order, and each adds to the same list.
  let writes = Promise.resolve();
  const remember = (uri) => {
    writes = writes.then(async () => {
      await mkdir(join(stateDir, "grove"), { recursive: true });
      await writeFile(manifest, JSON.stringify([...(await saved()), uri]), { mode: 0o600 });
    });
    return writes;
  };
  const send = async (file) => {
    const { storageKey, uri, gatewayUrl } = await client.uploadFile(file, { acl: await acl() });
    await remember(uri);
    return { key: storageKey, uri, url: gatewayUrl };
  };
  const upload = async (path, type) => send(new File([await readFile(path)], basename(path), { type }));
  return {
    upload,
    uploadText: (text, type) => send(new File([text], "file", { type })),
    uploadJson: (value) => send(new File([JSON.stringify(value)], "data.json", { type: "application/json" })),
    /** A stream is many small files. The results stay in the order given. */
    async uploadAll(paths, type) {
      const results = new Array(paths.length);
      let next = 0;
      const worker = async () => {
        while (next < paths.length) {
          const index = next++;
          results[index] = await upload(paths[index], type);
        }
      };
      await Promise.all(Array.from({ length: UPLOADS_AT_ONCE }, worker));
      return results;
    },
    /** Removes what it can, and resolves to true when something had to stay. */
    async remove() {
      await writes.catch(() => {});
      const uris = await saved();
      if (!uris.length) return false;
      const wallet = await ethereumKey(stateDir, "grove");
      const left = [];
      for (const uri of uris) {
        const removed = await client.delete(uri, wallet).catch(() => ({ success: false }));
        if (!removed.success) left.push(uri);
      }
      if (left.length) {
        await writeFile(manifest, JSON.stringify(left), { mode: 0o600 });
        return true;
      }
      await rm(manifest, { force: true });
      return false;
    },
  };
}
