import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const label = "dev.kualta.publisher";

const xml = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// launchd starts the helper at login and restarts it whenever it exits.
export function launchAgent({ node, root, path, log }) {
  const string = (value) => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>${string(node)}${string(join(root, "scripts/publisher/cli.mjs"))}${string("start")}</array>
  <key>WorkingDirectory</key>${string(root)}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${string(path)}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`;
}

const agents = join(homedir(), "Library/LaunchAgents");
const plist = join(agents, `${label}.plist`);
const domain = `gui/${process.getuid()}`;
// Unloading an agent that is not loaded fails harmlessly.
const unload = () => exec("launchctl", ["bootout", `${domain}/${label}`]).catch(() => {});

export async function install({ root, stateDir }) {
  const log = join(stateDir, "helper.log");
  await mkdir(agents, { recursive: true });
  await writeFile(plist, launchAgent({ node: process.execPath, root, path: process.env.PATH, log }), { mode: 0o644 });
  await unload();
  await exec("launchctl", ["bootstrap", domain, plist]);
  return log;
}

export async function uninstall() {
  await unload();
  await rm(plist, { force: true });
}
