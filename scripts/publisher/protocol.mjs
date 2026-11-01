import { chmod, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** The platform said no, or the attempt ended before reaching it: nothing was posted, so retrying can't duplicate it. */
export function rejected(message) {
  return Object.assign(new Error(message), { rejected: true });
}
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const keyPath = (stateDir, name) => join(stateDir, `${name}.key`);
export async function readKey(stateDir, name) {
  try {
    return (await readFile(keyPath(stateDir, name), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
export async function saveKey(stateDir, name, value) {
  await writeFile(keyPath(stateDir, name), value, { mode: 0o600 });
  await chmod(keyPath(stateDir, name), 0o600);
}
export const deleteKey = (stateDir, name) => rm(keyPath(stateDir, name), { force: true });
/** The laptop's own Ethereum key of this name, created on first use. */
export async function ethereumKey(stateDir, name) {
  let key = await readKey(stateDir, name);
  if (!key) {
    key = generatePrivateKey();
    await saveKey(stateDir, name, key);
  }
  return privateKeyToAccount(key);
}
