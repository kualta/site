import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrove } from "./grove.mjs";

const dirs = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function state() {
  const dir = await mkdtemp(join(tmpdir(), "publisher-grove-"));
  dirs.push(dir);
  return dir;
}
function fakeClient({ refuse = [] } = {}) {
  let next = 0;
  const made = () => {
    const key = `key${next++}`;
    return { storageKey: key, uri: `lens://${key}`, gatewayUrl: `https://api.grove.storage/${key}` };
  };
  const client = {
    files: [],
    acls: [],
    deleted: [],
    uploadFile: async (file, { acl }) => {
      client.files.push(file);
      client.acls.push(acl);
      return made();
    },
    delete: async (uri) => {
      client.deleted.push(uri);
      if (refuse.includes(uri)) throw new Error("Could not find resource");
      return { success: true };
    },
  };
  return client;
}
test("uploads keep their type, belong to this laptop's key, and report their address", async () => {
  const dir = await state();
  const path = join(dir, "photo.jpg");
  await writeFile(path, "pixels");
  const client = fakeClient();
  const grove = createGrove(dir, "lens-job", { client });
  const result = await grove.upload(path, "image/jpeg");
  expect(result).toEqual({ key: "key0", uri: "lens://key0", url: "https://api.grove.storage/key0" });
  expect(client.files[0].type).toBe("image/jpeg");
  expect(client.files[0].name).toBe("photo.jpg");
  expect(client.acls[0].template).toBe("wallet_address");
  expect(client.acls[0].chainId).toBe(232);
  expect((await stat(join(dir, "grove.key"))).mode & 0o777).toBe(0o600);
});
test("a stream's many segments keep their order and all get listed, whatever order they finish in", async () => {
  const dir = await state();
  const paths = Array.from({ length: 11 }, (_, i) => join(dir, `${String(i).padStart(4, "0")}.ts`));
  for (const path of paths) await writeFile(path, "segment");
  const client = fakeClient();
  let busy = 0;
  let most = 0;
  client.uploadFile = async (file) => {
    most = Math.max(most, ++busy);
    await new Promise((resolve) => setTimeout(resolve, 12 - Number(file.name.slice(0, 4))));
    busy--;
    return { storageKey: file.name, uri: `lens://${file.name}`, gatewayUrl: `https://api.grove.storage/${file.name}` };
  };
  const grove = createGrove(dir, "farcaster-job", { client });
  const segments = await grove.uploadAll(paths, "video/mp2t");
  expect(segments.map((segment) => segment.key)).toEqual(paths.map((path) => path.split("/").at(-1)));
  expect(most).toBe(4);
  expect(await grove.remove()).toBe(false);
  expect(client.deleted.toSorted()).toEqual(segments.map((segment) => segment.uri));
});
test("removal finds files from an earlier run of the helper, then forgets them", async () => {
  const dir = await state();
  const client = fakeClient();
  const first = createGrove(dir, "lens-job", { client });
  await first.uploadText("playlist", "application/vnd.apple.mpegurl");
  await first.uploadJson({ hello: "lens" });
  expect(client.files[1].type).toStartWith("application/json");
  const later = createGrove(dir, "lens-job", { client });
  expect(await later.remove()).toBe(false);
  expect(client.deleted).toEqual(["lens://key0", "lens://key1"]);
  client.deleted.length = 0;
  expect(await later.remove()).toBe(false);
  expect(client.deleted).toEqual([]);
});
test("what can't be removed is reported and kept for a later attempt", async () => {
  const dir = await state();
  const client = fakeClient({ refuse: ["lens://key1"] });
  const grove = createGrove(dir, "lens-job", { client });
  await grove.uploadText("a", "text/plain");
  await grove.uploadText("b", "text/plain");
  expect(await grove.remove()).toBe(true);
  expect(JSON.parse(await readFile(join(dir, "grove", "lens-job.json"), "utf8"))).toEqual(["lens://key1"]);
});
test("publications don't share a list", async () => {
  const dir = await state();
  const client = fakeClient();
  await createGrove(dir, "lens-one", { client }).uploadText("a", "text/plain");
  expect(await createGrove(dir, "lens-two", { client }).remove()).toBe(false);
  expect(client.deleted).toEqual([]);
});
