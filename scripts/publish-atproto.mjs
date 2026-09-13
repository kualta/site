import { readFile } from "node:fs/promises";
import { AtpAgent } from "@atproto/api";
import { syncRecords, verifyWebsite, waitForWebsite } from "./lib/atproto-publish.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--verify"].includes(arg))) throw new Error("Use --dry-run or --verify");
const manifest = JSON.parse(await readFile("public/.well-known/site.standard.manifest.json", "utf8"));
if (args.includes("--dry-run")) {
  console.log(`Publication: ${manifest.publication.uri}`);
  for (const doc of manifest.documents)
    console.log(`${doc.record.title}: ${doc.uri} (${Buffer.byteLength(doc.record.textContent)} text bytes)`);
} else {
  const verifyOnly = args.includes("--verify");
  if (verifyOnly) await verifyWebsite(manifest);
  else await waitForWebsite(manifest);
  const password = process.env.ATP_APP_PASSWORD;
  if (!verifyOnly && !password) throw new Error("Set ATP_APP_PASSWORD to enable AT Protocol publishing");
  const response = await fetch(`https://plc.directory/${manifest.did}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`DID resolution failed: ${response.status}`);
  const identity = await response.json();
  const pds = identity.service?.find((service) => service.type === "AtprotoPersonalDataServer")?.serviceEndpoint;
  if (!pds || new URL(pds).protocol !== "https:") throw new Error("Identity has no HTTPS PDS");
  const agent = new AtpAgent({ service: pds });
  if (!verifyOnly) await agent.login({ identifier: manifest.did, password });
  await syncRecords(manifest, agent, { verifyOnly });
}
