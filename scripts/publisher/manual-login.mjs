import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Credentials are entered in ordinary Chrome, without an automation connection. */
export async function manualLogin(
  profile,
  url,
  active,
  {
    launch = spawn,
    prepare = (path) => mkdir(path, { recursive: true, mode: 0o700 }),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  } = {},
) {
  await prepare(profile);
  const child = launch(
    chrome,
    [
      `--user-data-dir=${resolve(profile)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--new-window",
      url,
    ],
    { stdio: "ignore" },
  );
  let stopped = false;
  let failure;
  child.once("error", () => {
    stopped = true;
    failure = new Error("Could not start Chrome. Install Google Chrome and try again.");
  });
  child.once("exit", (code) => {
    stopped = true;
    if (code && !failure)
      failure = new Error("Chrome stopped unexpectedly. Close the publisher’s Chrome window and reconnect.");
  });
  try {
    const deadline = now() + 10 * 60_000;
    while (now() < deadline) {
      if (failure) throw failure;
      if ((await active()).confirmed) return;
      await wait(1000);
    }
    throw new Error("Sign-in timed out. Connect again to continue.");
  } finally {
    // Release the dedicated profile before Playwright reads the saved session.
    // Never terminate the user's regular Chrome process or force-kill a profile.
    if (!stopped) {
      child.kill("SIGTERM");
      const deadline = now() + 10_000;
      while (!stopped && now() < deadline) await wait(100);
      if (!stopped) throw new Error("Quit the publisher’s Chrome window, then reconnect to finish saving the session.");
    }
  }
}
