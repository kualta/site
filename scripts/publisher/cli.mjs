#!/usr/bin/env node
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { publish } from "./runner.mjs";
import { laptopKeys, connectAccount } from "./connections.mjs";
const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const stateDir = join(root, ".publisher");
const configFile = join(stateDir, "config.json");
process.umask(0o077);
process.env.FFMPEG_PATH ||= ffmpeg;
process.env.FFPROBE_PATH ||= ffprobe.path;
await mkdir(stateDir, { recursive: true, mode: 0o700 });
let config = { origin: "https://post.kualta.dev", platforms: [] };
try {
  config = JSON.parse(await readFile(configFile, "utf8"));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
async function save() {
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await chmod(configFile, 0o600);
}
async function api(path, data) {
  const response = await fetch(`${config.origin}/api/publisher/helper/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Publisher request failed (${response.status})`);
  return response;
}
async function python(script, args) {
  let output;
  try {
    output = await exec(
      join(stateDir, "venv/bin/python"),
      [join(root, "scripts/publisher/vendor", script), ...args],
      {
        timeout: 20 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch (e) {
    output = e;
  }
  const line = String(output.stdout || "")
    .trim()
    .split("\n")
    .at(-1);
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("Browser publisher stopped without a confirmed result");
  }
}

const [command] = process.argv.slice(2);
if (command === "connect") {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const origin =
      (await prompt.question("Publisher URL [https://post.kualta.dev]: ")).trim() ||
      "https://post.kualta.dev";
    const url = new URL(origin);
    if (
      url.origin !== "https://post.kualta.dev" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    )
      throw new Error("Use post.kualta.dev or localhost");
    const token = (await prompt.question("Pairing key: ")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid pairing key");
    config.origin = url.origin;
    config.token = token;
    await api("heartbeat", {});
    await save();
    console.log("Connected. Run bun run publisher start, then connect accounts in the composer.");
  } finally {
    prompt.close();
  }
} else if (command === "start") {
  if (!config.token) throw new Error("Connect the helper first");
  await exec("exiftool", ["-ver"]);
  await exec(process.env.FFMPEG_PATH, ["-version"]);
  const keys = await laptopKeys(stateDir);
  console.log("Publisher ready. Keep this terminal open. Ctrl+C stops the helper.");
  setInterval(() => api("heartbeat", {}).catch(() => {}), 30_000).unref();
  while (true) {
    try {
      config = JSON.parse(await readFile(configFile, "utf8"));
      const { target, post, connection } = await (
        await api("claim", { platforms: config.platforms, publicKey: keys.publicKey })
      ).json();
      if (connection) {
        const result = await connectAccount(connection, { stateDir, config, keys, api, save });
        // Retry the receipt only; never reopen or repeat an account action.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await api("accounts/result", { id: connection.id, claim: connection.claim, ...result });
            break;
          } catch (error) {
            if (attempt === 4) console.error("Connection receipt could not be saved. Refresh the composer.");
            else await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
        console.log(`${connection.platform}: ${result.message}`);
        continue;
      }
      if (target) {
        console.log(`Publishing ${target.platform}…`);
        const result = await publish(target, post, { api, config, stateDir, python });
        // Only delivery acknowledgements retry. Never repeat a publishing action.
        let delivered = false;
        for (let i = 0; i < 5 && !delivered; i++) {
          try {
            const response = await (
              await api("result", { id: target.id, claim: target.claim, ...result })
            ).json();
            delivered = response.ok;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
        console.log(
          `${target.platform}: ${result.state}${delivered ? "" : " (receipt not saved; check the platform)"}`,
        );
      } else await new Promise((resolve) => setTimeout(resolve, 5000));
    } catch (e) {
      console.error(e.message);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
} else console.log("Usage: bun run publisher connect | start");
