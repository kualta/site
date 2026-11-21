import { describe, expect, test } from "bun:test";
import { Lexicons } from "@atproto/lexicon";
import { linksRecord, projectRecord, schemaRecords, syncProfile, tangledRepoUri } from "./atproto-profile.mjs";
import { ownLexicons, validateRecord } from "./atproto-validation.mjs";

const config = { did: "did:plc:jhvnnnd3adml7t6anu3ay7ip", url: "https://kualta.dev" };
const project = {
  id: 9,
  name: "site",
  description: "web infrastructure",
  link: "https://www.kualta.dev/",
  git_link: "https://github.com/kualta/site.git",
  language: "TypeScript",
  date: "2021-06-01",
  status: "ongoing",
  tech_stack: ["Astro"],
  full_name: null,
  relevance: 100,
};
const contacts = [
  { id: 2, platform: "email", label: "contact@kualta.dev", link: "mailto:contact@kualta.dev", description: null },
  { id: 1, platform: "github", label: "kualta", link: "https://github.com/kualta", description: "code" },
];
const tangledSite = {
  uri: `at://${config.did}/sh.tangled.repo/site`,
  cid: "tangled",
  value: { $type: "sh.tangled.repo", description: "Mirror of https://github.com/kualta/site — web infrastructure" },
};
const quiet = { log() {} };

function snapshot() {
  return {
    did: config.did,
    schemas: schemaRecords(config),
    projects: [projectRecord(config, project)],
    links: linksRecord(config, contacts, "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nkey\n"),
  };
}

function fakePds(initial = [tangledSite]) {
  const records = new Map(initial.map((entry) => [entry.uri, entry]));
  let writes = 0;
  const repo = {
    async listRecords({ collection }) {
      return { data: { records: [...records.values()].filter((record) => record.value.$type === collection) } };
    },
    async putRecord({ collection, rkey, record, swapRecord }) {
      const uri = `at://${config.did}/${collection}/${rkey}`;
      if ((records.get(uri)?.cid ?? null) !== swapRecord) throw new Error("InvalidSwap");
      records.set(uri, { uri, cid: `revision-${++writes}`, value: structuredClone(record) });
    },
    async getRecord({ collection, rkey }) {
      return { data: records.get(`at://${config.did}/${collection}/${rkey}`) };
    },
  };
  return { agent: { did: config.did, com: { atproto: { repo } } }, repo, records, writes: () => writes };
}

describe("profile records", () => {
  test("a project keeps its record key through edits and drops empty fields", () => {
    const first = projectRecord(config, project);
    const edited = projectRecord(config, { ...project, name: "renamed", date: "2022-01-01" });
    expect(edited.uri).toBe(first.uri);
    expect(first.uri).toMatch(/^at:\/\/did:plc:[a-z0-9]+\/dev\.kualta\.project\/[234567ab][2-7a-z]{12}$/);
    expect(projectRecord(config, { ...project, id: 10 }).uri).not.toBe(first.uri);
    expect(first.record).toEqual({
      $type: "dev.kualta.project",
      name: "site",
      description: "web infrastructure",
      status: "ongoing",
      date: "2021-06-01T00:00:00.000Z",
      url: "https://www.kualta.dev/",
      gitUrl: "https://github.com/kualta/site.git",
      language: "TypeScript",
      techStack: ["Astro"],
      relevance: 100,
    });
    expect(() => validateRecord(first.record)).not.toThrow();
    expect(() => validateRecord({ ...first.record, url: "not a url" })).toThrow();
    expect(() => projectRecord(config, { ...project, id: undefined })).toThrow("stable integer id");
  });

  test("links keep their order and carry the armored key", () => {
    const { uri, record } = linksRecord(config, contacts, "-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nkey\n");
    expect(uri).toBe(`at://${config.did}/dev.kualta.links/self`);
    expect(record.links).toEqual([
      { platform: "email", label: "contact@kualta.dev", url: "mailto:contact@kualta.dev" },
      { platform: "github", label: "kualta", url: "https://github.com/kualta", description: "code" },
    ]);
    expect(record.pgpKey).toBe("-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nkey");
    expect(() => validateRecord(record)).not.toThrow();
    expect(() => validateRecord({ ...record, links: [{ platform: "email" }] })).toThrow();
  });

  test("every dev.kualta lexicon becomes a schema record keyed by its NSID", () => {
    const lexicons = ownLexicons();
    const ids = lexicons.map((lexicon) => lexicon.id);
    expect(ids).toEqual(expect.arrayContaining(["dev.kualta.links", "dev.kualta.project"]));
    expect(ids.every((id) => id.startsWith("dev.kualta."))).toBe(true);
    expect(() => new Lexicons(lexicons)).not.toThrow();
    const schemas = schemaRecords(config, lexicons);
    expect(schemas.map((schema) => schema.uri)).toEqual(
      ids.map((id) => `at://${config.did}/com.atproto.lexicon.schema/${id}`),
    );
    for (const [index, schema] of schemas.entries()) {
      expect(schema.record).toEqual({ $type: "com.atproto.lexicon.schema", ...lexicons[index] });
      expect(() => validateRecord(schema.record)).not.toThrow();
    }
  });

  test("a Tangled repo matches by its source or the URL in its description", () => {
    const bySource = {
      uri: "at://did:plc:x/sh.tangled.repo/pomo",
      value: { source: "https://github.com/kualta/pomo" },
    };
    const repos = [tangledSite, bySource];
    expect(tangledRepoUri(repos, "https://github.com/kualta/site.git")).toBe(tangledSite.uri);
    expect(tangledRepoUri(repos, "https://GitHub.com/kualta/pomo/")).toBe(bySource.uri);
    expect(tangledRepoUri(repos, "https://github.com/kualta/site-two")).toBeUndefined();
    expect(tangledRepoUri(repos, "https://github.com/kualta")).toBeUndefined();
    expect(tangledRepoUri(repos, null)).toBeUndefined();
  });
});

describe("profile publishing", () => {
  test("creates, links Tangled, repeats without writes, updates in place and verifies", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    const expected = manifest.schemas.length + 2;
    await syncProfile(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(expected);
    expect(pds.records.get(manifest.projects[0].uri).value.repo).toBe(tangledSite.uri);
    expect(pds.records.get(manifest.links.uri).value).toEqual(manifest.links.record);
    await syncProfile(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(expected);
    await syncProfile(manifest, { com: pds.agent.com }, { ...quiet, verifyOnly: true });
    manifest.projects[0].record.status = "archived";
    await expect(syncProfile(manifest, pds.agent, { ...quiet, verifyOnly: true })).rejects.toThrow("differs");
    await syncProfile(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(expected + 1);
    expect(pds.records.size).toBe(expected + 1);
  });

  test("an unresolved Tangled listing omits the link, and a failed one keeps the published link", async () => {
    const unlinked = fakePds([]);
    const manifest = snapshot();
    await syncProfile(manifest, unlinked.agent, quiet);
    expect(unlinked.records.get(manifest.projects[0].uri).value).not.toHaveProperty("repo");

    const pds = fakePds();
    await syncProfile(manifest, pds.agent, quiet);
    const writes = pds.writes();
    const list = pds.repo.listRecords;
    pds.repo.listRecords = async (request) => {
      if (request.collection === "sh.tangled.repo") throw new Error("Tangled listing failed");
      return list(request);
    };
    await syncProfile(manifest, pds.agent, quiet);
    expect(pds.writes()).toBe(writes);
    expect(pds.records.get(manifest.projects[0].uri).value.repo).toBe(tangledSite.uri);
  });

  test("stops and lists the stale URI when a project or lexicon is removed", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    await syncProfile(manifest, pds.agent, quiet);
    const writes = pds.writes();
    const removed = manifest.projects.pop();
    manifest.links.record.links = [];
    await expect(syncProfile(manifest, pds.agent, quiet)).rejects.toThrow(removed.uri);
    manifest.projects.push(removed);
    const schema = manifest.schemas.pop();
    await expect(syncProfile(manifest, pds.agent, quiet)).rejects.toThrow(schema.uri);
    expect(pds.writes()).toBe(writes);
    expect(pds.records.has(removed.uri)).toBe(true);
  });

  test("leaves schemas of other namespaces alone", async () => {
    const foreign = {
      uri: `at://${config.did}/com.atproto.lexicon.schema/com.example.thing`,
      cid: "foreign",
      value: { $type: "com.atproto.lexicon.schema", lexicon: 1, id: "com.example.thing" },
    };
    const pds = fakePds([foreign]);
    await syncProfile(snapshot(), pds.agent, quiet);
    expect(pds.records.get(foreign.uri)).toBe(foreign);
  });

  test("refuses another identity, unreadable state and concurrent edits", async () => {
    const pds = fakePds();
    const manifest = snapshot();
    await expect(syncProfile(manifest, { ...pds.agent, did: "did:plc:other" }, quiet)).rejects.toThrow("identity");
    const list = pds.repo.listRecords;
    pds.repo.listRecords = async () => {
      throw new Error("PDS unavailable");
    };
    await expect(syncProfile(manifest, pds.agent, quiet)).rejects.toThrow("PDS unavailable");
    expect(pds.writes()).toBe(0);
    pds.repo.listRecords = list;
    await syncProfile(manifest, pds.agent, quiet);
    manifest.links.record.links = manifest.links.record.links.slice(0, 1);
    const put = pds.repo.putRecord;
    pds.repo.putRecord = async (request) => {
      pds.records.get(manifest.links.uri).cid = "concurrent-revision";
      return put(request);
    };
    await expect(syncProfile(manifest, pds.agent, quiet)).rejects.toThrow("InvalidSwap");
    expect(pds.records.get(manifest.links.uri).value.links).toHaveLength(2);
  });
});
