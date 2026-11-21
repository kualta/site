import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { recordKey } from "./atproto-content.mjs";
import { key, listRecords, plain, putVerified } from "./atproto-publish.mjs";
import { ownLexicons, validateRecord } from "./atproto-validation.mjs";

const SCHEMA = "com.atproto.lexicon.schema";
const PROJECT = "dev.kualta.project";
const LINKS = "dev.kualta.links";
const TANGLED_REPO = "sh.tangled.repo";

const present = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));

export function projectRecord(config, project) {
  if (!Number.isInteger(project.id)) throw new Error(`Project needs a stable integer id: ${project.name}`);
  return {
    uri: `at://${config.did}/${PROJECT}/${recordKey(`${PROJECT}:${project.id}`)}`,
    record: present({
      $type: PROJECT,
      name: project.name,
      fullName: project.full_name,
      description: project.description,
      status: project.status,
      date: project.date && new Date(project.date).toISOString(),
      url: project.link,
      gitUrl: project.git_link,
      language: project.language,
      techStack: project.tech_stack,
      relevance: project.relevance,
    }),
  };
}

export function linksRecord(config, contacts, pgpKey) {
  return {
    uri: `at://${config.did}/${LINKS}/self`,
    record: {
      $type: LINKS,
      links: contacts.map((contact) =>
        present({
          platform: contact.platform,
          label: contact.label,
          url: contact.link,
          description: contact.description,
        }),
      ),
      pgpKey: pgpKey.trim(),
    },
  };
}

export function schemaRecords(config, lexicons = ownLexicons()) {
  return lexicons.map((lexicon) => ({
    uri: `at://${config.did}/${SCHEMA}/${lexicon.id}`,
    record: { $type: SCHEMA, ...lexicon },
  }));
}

export async function profileRecords(config, root) {
  const read = (file) => readFile(path.join(root, file), "utf8");
  const projects = JSON.parse(await read("src/data/projects.json")).map((project) => projectRecord(config, project));
  if (new Set(projects.map((project) => project.uri)).size !== projects.length)
    throw new Error("Duplicate project ids");
  const records = {
    schemas: schemaRecords(config),
    projects,
    links: linksRecord(
      config,
      JSON.parse(await read("src/data/contacts.json")),
      await read("public/keys/kualta_pgp.asc"),
    ),
  };
  for (const item of [...records.schemas, ...projects, records.links]) validateRecord(item.record);
  return records;
}

const gitLocation = (url) =>
  url
    .toLowerCase()
    .replace(/[/.,;:)]+$/, "")
    .replace(/\.git$/, "");

export function tangledRepoUri(repos, gitUrl) {
  if (!gitUrl) return undefined;
  const wanted = gitLocation(gitUrl);
  return repos.find((entry) =>
    [entry.value.source, ...(entry.value.description?.match(/https?:\/\/\S+/g) ?? [])].some(
      (url) => typeof url === "string" && gitLocation(url) === wanted,
    ),
  )?.uri;
}

export async function syncProfile(manifest, agent, { verifyOnly = false, log = console.log } = {}) {
  if (!verifyOnly && agent.did !== manifest.did) throw new Error("Authenticated identity does not match site owner");
  const repo = agent.com.atproto.repo;
  const groups = [
    { collection: SCHEMA, items: manifest.schemas, owned: (entry) => key(entry.uri).startsWith("dev.kualta.") },
    { collection: PROJECT, items: manifest.projects },
    { collection: LINKS, items: [manifest.links] },
  ];
  for (const group of groups) {
    group.existing = await listRecords(repo, manifest.did, group.collection);
    const expected = new Set(group.items.map((item) => item.uri));
    const stale = group.existing.filter((entry) => (group.owned?.(entry) ?? true) && !expected.has(entry.uri));
    if (stale.length)
      throw new Error(
        `Previously published ${
          group.collection
        } records are no longer in the site data. Explicitly remove their AT records before retrying: ${stale
          .map((entry) => entry.uri)
          .join(", ")}`,
      );
  }
  // The Tangled link is optional: an unreadable listing keeps whatever link is already published.
  const tangled = await listRecords(repo, manifest.did, TANGLED_REPO).catch((error) => {
    log(`Tangled repos unavailable, keeping published links: ${error.message}`);
    return null;
  });
  for (const { collection, items, existing: entries } of groups) {
    for (const item of items) {
      const existing = entries.find((entry) => entry.uri === item.uri);
      const record = { ...item.record };
      if (collection === PROJECT) {
        const linked = tangled ? tangledRepoUri(tangled, record.gitUrl) : existing?.value.repo;
        if (linked) record.repo = linked;
      }
      validateRecord(record);
      if (isDeepStrictEqual(plain(existing?.value ?? null), plain(record))) {
        log(`Unchanged ${item.uri}`);
        continue;
      }
      if (verifyOnly) throw new Error(`Remote record differs: ${item.uri}`);
      await putVerified(repo, manifest.did, item.uri, record, existing, log);
    }
  }
}
