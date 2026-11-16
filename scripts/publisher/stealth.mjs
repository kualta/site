import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "patchright";
import { chrome } from "./manual-login.mjs";

/**
 * Chrome as a person runs it, driven without a trace. TikTok gave no views to videos a browser it could tell was
 * automated uploaded, while the same upload by hand got them. So this starts ordinary Chrome on the profile, as the
 * sign-in window does, adding only a debugging port at random and AutomationControlled off (an open port turns
 * navigator.webdriver on), and attaches Patchright, which leaves none of Playwright's traces such as Runtime.enable.
 * Nothing is overridden: window size, language and user agent are Chrome's own. rebrowser's bot detector
 * (bot-detector.rebrowser.net) finds nothing on it, where a Playwright launch fails four of its checks.
 *
 * Returns Chrome's own browser context. Closing it closes Chrome through the protocol, which lets Chrome save its
 * cookies first, as SIGTERM wouldn't.
 */
export async function openStealthProfile(
  path,
  headless = false,
  { launch = spawn, connect = (url) => chromium.connectOverCDP(url) } = {},
) {
  const profile = resolve(path);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // Chrome writes the port it picked here once it's listening; an old file would name a closed port.
  const portFile = join(profile, "DevToolsActivePort");
  await rm(portFile, { force: true });
  const child = launch(
    chrome,
    [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      // Skip the per-launch 1.4 GB app copy (see manual-login.mjs).
      "--disable-features=MacAppCodeSignClone",
      "--remote-debugging-port=0",
      "--disable-blink-features=AutomationControlled",
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let exited = false;
  const exit = new Promise((done) =>
    child.once("exit", () => {
      exited = true;
      done();
    }),
  );
  child.once("error", () => (exited = true));
  // Chrome outlives the helper unless told otherwise, and would hold the profile.
  const orphan = () => child.kill("SIGTERM");
  process.once("exit", orphan);
  try {
    let port;
    for (let waited = 0; !port; waited += 100) {
      // A second Chrome on a profile already open hands over to the first and exits.
      if (exited || waited > 20_000)
        throw new Error(
          "Chrome didn't start on this profile. Close the publisher's Chrome window for it and try again.",
        );
      await new Promise((done) => setTimeout(done, 100));
      port = await readFile(portFile, "utf8").then(
        (text) => text.split("\n")[0].trim(),
        () => undefined,
      );
    }
    const browser = await connect(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    context.close = async () => {
      process.removeListener("exit", orphan);
      if (exited) return;
      const session = await browser.newBrowserCDPSession().catch(() => null);
      await session?.send("Browser.close").catch(() => {});
      const timeout = new Promise((done) => setTimeout(done, 10_000));
      await Promise.race([exit, timeout]);
      if (!exited) child.kill("SIGTERM");
    };
    return context;
  } catch (error) {
    process.removeListener("exit", orphan);
    child.kill("SIGTERM");
    throw error;
  }
}
