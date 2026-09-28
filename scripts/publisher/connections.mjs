import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { webcrypto } from "node:crypto";
import { BskyAgent } from "@atproto/api";
import { destinations, openProfile } from "./browser.mjs";

const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";
const crypto = webcrypto;
export async function laptopKeys(stateDir) {
  const path = join(stateDir, "connection-key.json");
  let jwk;
  try {
    jwk = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const pair = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["encrypt", "decrypt"],
    );
    jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
    await writeFile(path, JSON.stringify(jwk), { mode: 0o600, flag: "wx" });
  }
  return {
    privateKey: await crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
      "decrypt",
    ]),
    publicKey: { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true },
  };
}
export async function decryptCredentials(envelope, privateKey) {
  const raw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    Buffer.from(envelope.key, "base64"),
  );
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const clear = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Buffer.from(envelope.iv, "base64") },
    key,
    Buffer.from(envelope.data, "base64"),
  );
  const data = JSON.parse(new TextDecoder().decode(clear));
  const service = new URL(data.service);
  if (
    service.protocol !== "https:" ||
    service.username ||
    service.password ||
    service.pathname !== "/" ||
    service.search ||
    service.hash ||
    typeof data.identifier !== "string" ||
    !data.identifier ||
    typeof data.password !== "string" ||
    !data.password
  )
    throw new Error("Invalid AT Protocol account details");
  return { service: service.origin, identifier: data.identifier, password: data.password };
}
// Session cookies are checked only after the owner finishes the interactive login.
export function hasSession(platform, cookies) {
  const names =
    {
      instagram: ["sessionid"],
      twitter: ["auth_token"],
      youtube: ["SAPISID", "__Secure-3PAPISID"],
      tiktok: ["sessionid", "sessionid_ss"],
      xiaohongshu: ["web_session"],
    }[platform] || [];
  return cookies.some(
    (cookie) =>
      names.includes(cookie.name) &&
      cookie.value &&
      (cookie.expires === -1 || cookie.expires > Date.now() / 1000),
  );
}
export async function connectAccount(
  connection,
  {
    stateDir,
    config,
    keys,
    api,
    save,
    open = openProfile,
    agentFactory = (service) => new BskyAgent({ service }),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  const atproto = ["grain", "bluesky"].includes(connection.platform);
  if (
    (!atproto && !Object.hasOwn(destinations, connection.platform)) ||
    !["connect", "disconnect"].includes(connection.action)
  )
    return { state: "failed", message: "Unsupported account action" };
  const affected = atproto ? ["grain", "bluesky"] : [connection.platform];
  const active = async () => {
    const status = await (await api(`accounts/${connection.id}`)).json();
    if (status?.state !== "working") throw new Error("Connection cancelled or expired");
    return status;
  };
  try {
    await active();
    if (connection.action === "disconnect") {
      if (atproto) delete config.atproto;
      else await rm(join(stateDir, connection.platform), { recursive: true, force: true });
      config.platforms = config.platforms.filter((p) => !affected.includes(p));
    } else if (atproto) {
      let credentials;
      try {
        credentials = await decryptCredentials(JSON.parse(connection.payload), keys.privateKey);
      } catch {
        throw new Error("Could not read account details. Refresh the composer and reconnect.");
      }
      const agent = agentFactory(credentials.service);
      try {
        await agent.login({ identifier: credentials.identifier, password: credentials.password });
      } catch {
        throw new Error("AT Protocol sign-in failed. Check the PDS, handle, and app password.");
      }
      if (agent.session?.did !== owner) throw new Error("Use kualta’s AT Protocol account");
      await active();
      config.atproto = credentials;
      config.platforms = [...new Set([...config.platforms, ...affected])];
    } else {
      const browser = await open(join(stateDir, connection.platform));
      try {
        const page = browser.pages()[0] || (await browser.newPage());
        await page.goto(destinations[connection.platform]);
        const deadline = Date.now() + 10 * 60_000;
        let confirmed = false;
        while (Date.now() < deadline) {
          if ((await active()).confirmed) {
            confirmed = true;
            break;
          }
          if (!browser.pages().length) throw new Error("Login window closed. Connect again to continue.");
          await wait(2000);
        }
        if (!confirmed) throw new Error("Sign-in timed out. Connect again to continue.");
        await page.goto(destinations[connection.platform]);
        if (
          /\/(login|accounts\/login|signin)(\/|\?|$)/i.test(page.url()) ||
          !hasSession(connection.platform, await browser.cookies(destinations[connection.platform]))
        )
          throw new Error(
            "No signed-in session found. Connect again and finish signing in before confirming.",
          );
        await active();
        config.platforms = [...new Set([...config.platforms, connection.platform])];
      } finally {
        await browser.close();
      }
    }
    await save();
    return { state: "succeeded", message: connection.action === "disconnect" ? "Disconnected" : "Connected" };
  } catch (error) {
    return { state: "failed", message: error.message };
  }
}
