import { manualLogin } from "./manual-login.mjs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { destinations, openProfile } from "./browser.mjs";

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
      names.includes(cookie.name) && cookie.value && (cookie.expires === -1 || cookie.expires > Date.now() / 1000),
  );
}
export async function connectAccount(
  connection,
  { stateDir, config, oauth, api, save, open = openProfile, login = manualLogin },
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
      if (atproto) {
        await oauth.disconnect();
        delete config.atproto;
      } else await rm(join(stateDir, connection.platform), { recursive: true, force: true });
      config.platforms = config.platforms.filter((p) => !affected.includes(p));
    } else if (atproto) {
      const did = await oauth.connect(active);
      await active();
      config.atproto = { did };
      config.platforms = [...new Set([...config.platforms, ...affected])];
    } else {
      const profile = join(stateDir, connection.platform);
      await login(profile, destinations[connection.platform], active);
      if (!(await active()).confirmed) throw new Error("Finish sign-in before checking the session.");
      const browser = await open(profile);
      try {
        const page = browser.pages()[0] || (await browser.newPage());
        await page.goto(destinations[connection.platform]);
        if (
          /\/(login|accounts\/login|signin)(\/|\?|$)/i.test(page.url()) ||
          !hasSession(connection.platform, await browser.cookies(destinations[connection.platform]))
        )
          throw new Error("No signed-in session found. Connect again and finish signing in before confirming.");
        await active();
        config.platforms = [...new Set([...config.platforms, connection.platform])];
      } finally {
        await browser.close();
      }
    }
    await save();
    return {
      state: "succeeded",
      message: connection.action === "disconnect" ? "Disconnected" : "Connected",
    };
  } catch (error) {
    return { state: "failed", message: error.message };
  }
}
