import { readFile } from "node:fs/promises";
import { AtpAgent } from "@atproto/api";
import { prepareMusic, verifyMusicAssets, publishMusic } from "./lib/music-publish.mjs";
import { syncMusicArtwork } from "./lib/music-artwork.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => !["--dry-run", "--verify"].includes(arg))) throw new Error("Use --dry-run or --verify");
const config = JSON.parse(await readFile("atproto.config.json", "utf8"));
const tracks = JSON.parse(await readFile("src/data/music.json", "utf8"));
const items = await prepareMusic(tracks, config.url);
if (args.includes("--dry-run")) {
  for (const item of items)
    console.log(`${item.slug}: ${item.record.audioBlob.size} audio bytes -> ${item.record.$type}`);
} else {
  const verifyOnly = args.includes("--verify");
  if (!verifyOnly && !process.env.ATP_APP_PASSWORD) throw new Error("Set ATP_APP_PASSWORD to publish music");
  if (!verifyOnly && !process.env.PLYR_TOKEN) throw new Error("Set PLYR_TOKEN to sync music artwork");
  const artistResponse = await fetch(`https://api.plyr.fm/artists/${encodeURIComponent(config.did)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!artistResponse.ok || (await artistResponse.json()).did !== config.did)
    throw new Error("Register the site's artist profile on plyr.fm before publishing music for discovery");
  await verifyMusicAssets(items);
  const response = await fetch(`https://plc.directory/${config.did}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`DID resolution failed: ${response.status}`);
  const identity = await response.json();
  const pds = identity.service?.find((service) => service.type === "AtprotoPersonalDataServer")?.serviceEndpoint;
  if (!pds || new URL(pds).protocol !== "https:") throw new Error("Identity has no HTTPS PDS");
  const agent = new AtpAgent({ service: pds });
  if (!verifyOnly) await agent.login({ identifier: config.did, password: process.env.ATP_APP_PASSWORD });
  await publishMusic(items, agent, config.did, { verifyOnly });
  await syncMusicArtwork(items, config.did, { verifyOnly, token: process.env.PLYR_TOKEN });
  // plyr's artwork API can rebuild metadata; restore the site's authoritative fields.
  await publishMusic(items, agent, config.did, { verifyOnly });
}
