import { describe, expect, test } from "bun:test";
import { articleRecord, portableContent, publicationUri, recordKey } from "./atproto-content.mjs";
import { coverBlob, syncRecords, verifyWebsite } from "./atproto-publish.mjs";
import { validateRecord } from "./atproto-validation.mjs";

const config = { did: "did:plc:jhvnnnd3adml7t6anu3ay7ip", url: "https://kualta.dev" };
const source = '---\ntitle: Example\ndate: "2026-09-13"\ntags: [writing]\n---\nHello **world**.';

function snapshot() {
  return {
    version: 1,
    did: config.did,
    publication: {
      uri: publicationUri(config),
      record: { $type: "site.standard.publication", url: config.url, name: "kualta.dev" },
    },
    documents: [articleRecord(config, "example", source)],
  };
}

function fakePds() {
  const records = new Map();
  let writes = 0;
  let loseResponse = false;
  const repo = {
    async listRecords({ collection }) {
      return { data: { records: [...records.values()].filter((record) => record.value.$type === collection) } };
    },
    async putRecord({ collection, rkey, record, swapRecord }) {
      const uri = `at://${config.did}/${collection}/${rkey}`;
      if ((records.get(uri)?.cid ?? null) !== swapRecord) throw new Error("InvalidSwap");
      records.set(uri, { uri, cid: `revision-${++writes}`, value: structuredClone(record) });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Connection lost after commit");
      }
      return { data: { uri } };
    },
    async getRecord({ collection, rkey }) {
      return { data: records.get(`at://${config.did}/${collection}/${rkey}`) };
    },
    async uploadBlob(bytes, { encoding }) {
      return { data: { blob: await coverBlob({ base64: bytes.toString("base64"), mimeType: encoding }) } };
    },
  };
  return {
    agent: { did: config.did, com: { atproto: { repo } } },
    records,
    writes: () => writes,
    loseNextResponse: () => {
      loseResponse = true;
    },
  };
}

const quiet = { log() {} };

describe("portable articles", () => {
  test("preserves code, images, reference links and prose without leaking Markdown into plain text", () => {
    const result = portableContent(
      "## Heading\n\nHello **world**.\n\n![A graph](/images/graph.png)\n\n```js\nconst x = 1;\n```\n\n[More][ref]\n\n[ref]: /posts/other/",
      `${config.url}/posts/example/`,
    );
    expect(result.markdown).toContain("https://kualta.dev/images/graph.png");
    expect(result.markdown).toContain("https://kualta.dev/posts/other/");
    expect(result.markdown).toContain("```js");
    expect(result.textContent).toContain("const x = 1;");
    expect(result.textContent).toContain("A graph");
    expect(result.textContent).not.toContain("**");
    expect(result.textContent).not.toContain("[ref]");
  });

  test("exports the explicit fallback and never evaluates interactive code", () => {
    const body =
      'import Interactive from "@/components/Interactive.astro";\n\n<Interactive>\n<Chart data={secretData} />\n<div slot="fallback">\n\nThe result is **42**.\n\n![Static result](/chart.png)\n\n</div>\n</Interactive>';
    const result = portableContent(body, `${config.url}/posts/example/`);
    expect(result.markdown).toContain("The result is **42**");
    expect(result.markdown).toContain("https://kualta.dev/chart.png");
    expect(result.markdown).toContain("Open the interactive version");
    expect(result.markdown).not.toContain("secretData");
    expect(result.markdown).not.toContain("import");
  });

  test("rejects missing fallbacks, unhandled JSX and dynamic prose", () => {
    for (const body of ["<Interactive><Chart /></Interactive>", "<Chart />", "The answer is {compute()}."]) {
      expect(() => portableContent(body, config.url)).toThrow();
    }
  });

  test("drafts are skipped before parsing incomplete MDX", () => {
    expect(articleRecord(config, "draft", source.replace("tags:", "draft: true\ntags:") + "\n<broken")).toBeNull();
  });

  test("edits retain a valid TID and record identity", () => {
    const first = articleRecord(config, "example", source);
    const edited = articleRecord(
      config,
      "example",
      source.replace("Example", "Changed").replace("2026-09-13", "2026-09-14"),
    );
    expect(edited.uri).toBe(first.uri);
    expect(recordKey("example")).toMatch(/^[234567ab][234567abcdefghijklmnopqrstuvwxyz]{12}$/);
    expect(() => validateRecord(first.record)).not.toThrow();
    expect(() => validateRecord({ ...first.record, title: "x".repeat(501) })).toThrow();
  });
});

describe("publishing", () => {
  test("creates, reads back, repeats without writes, and updates the same article", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    manifest.documents[0].cover = { base64: Buffer.from("image bytes").toString("base64"), mimeType: "image/webp" };
    await syncRecords(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(2);
    await syncRecords(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(2);
    manifest.documents[0].record.title = "Edited";
    await syncRecords(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(3);
    expect(pds.records.size).toBe(2);
    await syncRecords(manifest, pds.agent, { ...quiet, verifyOnly: true });
    manifest.documents[0].cover.base64 = Buffer.from("different image").toString("base64");
    await expect(syncRecords(manifest, pds.agent, { ...quiet, verifyOnly: true })).rejects.toThrow("differs");
    expect(pds.writes()).toBe(3);
  });

  test("recovers when the response is lost after a successful write", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    pds.loseNextResponse();
    await expect(syncRecords(manifest, pds.agent, quiet)).rejects.toThrow("Connection lost");
    await syncRecords(manifest, pds.agent, quiet);
    expect(pds.records.size).toBe(2);
    expect(pds.writes()).toBe(2);
  });

  test("does not create records when existing state cannot be read", async () => {
    const pds = fakePds();
    pds.agent.com.atproto.repo.listRecords = async () => {
      throw new Error("PDS unavailable");
    };
    await expect(syncRecords(snapshot(), pds.agent, quiet)).rejects.toThrow("PDS unavailable");
    expect(pds.writes()).toBe(0);
  });

  test("refuses a different identity or an existing publication under another key", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    await expect(syncRecords(manifest, { ...pds.agent, did: "did:plc:other" }, quiet)).rejects.toThrow("identity");
    const uri = manifest.publication.uri + "other";
    pds.records.set(uri, { uri, cid: "old", value: manifest.publication.record });
    await expect(syncRecords(manifest, pds.agent, quiet)).rejects.toThrow("already exists");
    expect(pds.writes()).toBe(0);
  });

  test("blocks silent removal of previously published articles", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    await syncRecords(manifest, pds.agent, quiet);
    manifest.documents = [];
    await expect(syncRecords(manifest, pds.agent, quiet)).rejects.toThrow("removed or made drafts");
    expect(pds.records.size).toBe(2);
  });

  test("requires the deployed snapshot and both verification links", async () => {
    const manifest = snapshot();
    const responses = new Map([
      [`${config.url}/.well-known/site.standard.manifest.json`, JSON.stringify(manifest)],
      [`${config.url}/.well-known/site.standard.publication`, manifest.publication.uri],
      [`${config.url}/posts/example/`, `<link rel="site.standard.document" href="${manifest.documents[0].uri}">`],
    ]);
    const fetcher = async (url) => new Response(responses.get(url), { status: responses.has(url) ? 200 : 404 });
    await verifyWebsite(manifest, fetcher);
    responses.set(`${config.url}/posts/example/`, "<h1>Missing verification</h1>");
    await expect(verifyWebsite(manifest, fetcher)).rejects.toThrow("Missing document verification");
    responses.set(`${config.url}/.well-known/site.standard.manifest.json`, "{}");
    await expect(verifyWebsite(manifest, fetcher)).rejects.toThrow("differs");
  });
});
