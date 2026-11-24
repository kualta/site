import { manualLogin } from "./manual-login.mjs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { destination, destinations, openProfile } from "./browser.mjs";
import { connectFarcaster, disconnectFarcaster } from "./farcaster.mjs";
import { FOOTAGE, FOOTAGE_HOME, channelIn } from "./footage.mjs";
import { connectLens, disconnectLens } from "./lens.mjs";
import { hasSession } from "./sessions.mjs";

// Posted to directly with their own keys, so there's no browser session to keep.
const keyed = {
  farcaster: { connect: connectFarcaster, disconnect: disconnectFarcaster },
  lens: { connect: connectLens, disconnect: disconnectLens },
};

// Where each browser account signs in: the destinations, and the footage archive's own YouTube channel.
const sites = { ...destinations, [FOOTAGE]: FOOTAGE_HOME };

/** The channel the YouTube destination posts to, so the footage archive never lands on it. */
async function postingChannel(stateDir, open) {
  const browser = await open(join(stateDir, "youtube"), true);
  try {
    return (await channelIn(browser.pages()[0] || (await browser.newPage()))).channel;
  } finally {
    await browser.close();
  }
}

/**
 * Which channel the footage archive's window is on, kept with the page id that picks it among an account's channels.
 * Refused when it's the channel posts go to: switching to the archive channel is easy to forget.
 */
async function footageChannel(page, { stateDir, config, open }) {
  const { channel, pageId } = await channelIn(page);
  if (!channel)
    throw new Error("No YouTube channel in that window. Make the archive channel, switch to it, then connect again.");
  if (config.platforms.includes("youtube") && (await postingChannel(stateDir, open)) === channel)
    throw new Error(
      `youtube.com/${channel} is the channel you post to. In the Chrome window, switch to the archive channel, then connect again.`,
    );
  config.footage = { ...config.footage, channel, pageId };
  return `Every graded clip goes up unlisted to youtube.com/${channel}`;
}
export async function connectAccount(
  connection,
  { stateDir, config, oauth, api, save, open = openProfile, login = manualLogin, accounts = keyed },
) {
  const atproto = ["grain", "bluesky"].includes(connection.platform);
  const account = Object.hasOwn(accounts, connection.platform) ? accounts[connection.platform] : null;
  if (
    (!atproto && !account && !Object.hasOwn(sites, connection.platform)) ||
    !["connect", "disconnect"].includes(connection.action)
  )
    return { state: "failed", message: "Unsupported account action" };
  let connected = "Connected";
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
      } else if (account) await account.disconnect({ stateDir });
      else await rm(join(stateDir, connection.platform), { recursive: true, force: true });
      if (connection.platform === FOOTAGE) delete config.footage;
      config.platforms = config.platforms.filter((p) => !affected.includes(p));
    } else if (atproto) {
      const did = await oauth.connect(active);
      await active();
      config.atproto = { did };
      config.platforms = [...new Set([...config.platforms, ...affected])];
    } else if (account) {
      const report = (message) => api("accounts/progress", { id: connection.id, claim: connection.claim, message });
      await account.connect(active, { stateDir, report });
      await active();
      config.platforms = [...new Set([...config.platforms, connection.platform])];
    } else {
      const profile = join(stateDir, connection.platform);
      await login(profile, sites[connection.platform], active);
      if (!(await active()).confirmed) throw new Error("Finish sign-in before checking the session.");
      const browser = await open(profile);
      try {
        const page = browser.pages()[0] || (await browser.newPage());
        const url = connection.platform === FOOTAGE ? FOOTAGE_HOME : await destination(connection.platform, browser);
        await page.goto(url);
        if (
          /\/(login|accounts\/login|signin)(\/|\?|$)/i.test(page.url()) ||
          !hasSession(connection.platform, await browser.cookies(url))
        )
          throw new Error("No signed-in session found. Try again, and finish signing in before confirming.");
        if (connection.platform === FOOTAGE) connected = await footageChannel(page, { stateDir, config, open });
        await active();
        config.platforms = [...new Set([...config.platforms, connection.platform])];
      } finally {
        await browser.close();
      }
    }
    await save();
    return {
      state: "succeeded",
      message: connection.action === "disconnect" ? "Disconnected" : connected,
    };
  } catch (error) {
    return { state: "failed", message: error.message };
  }
}
