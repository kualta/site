import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStealthProfile } from "./stealth.mjs";

/** A Chrome that writes its port like the real one, or exits at once as one handing over to an open window does. */
function fakeChrome({ handsOver = false } = {}) {
  const launched = { args: null, killed: null };
  const launch = (_binary, args) => {
    launched.args = args;
    const child = new EventEmitter();
    child.kill = (signal) => {
      launched.killed = signal;
      child.emit("exit", null);
    };
    const profile = args.find((arg) => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    setTimeout(() => {
      if (handsOver) child.emit("exit", 0);
      else writeFile(join(profile, "DevToolsActivePort"), "52345\n/devtools/browser/abc\n");
    }, 50);
    launched.child = child;
    return child;
  };
  return { launched, launch };
}

test("opens ordinary Chrome with only a random debugging port and AutomationControlled off", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stealth-"));
  try {
    // A port file from an earlier run must not be read.
    await writeFile(join(profile, "DevToolsActivePort"), "1\n");
    const { launched, launch } = fakeChrome();
    const sent = [];
    let connectedTo;
    const context = { pages: () => [] };
    const browser = {
      contexts: () => [context],
      newBrowserCDPSession: async () => ({
        send: async (method) => {
          sent.push(method);
          launched.child.emit("exit", 0);
        },
      }),
    };
    const opened = await openStealthProfile(profile, false, {
      launch,
      connect: async (url) => {
        connectedTo = url;
        return browser;
      },
    });
    expect(opened).toBe(context);
    expect(connectedTo).toBe("http://127.0.0.1:52345");
    expect(launched.args).toContain("--remote-debugging-port=0");
    expect(launched.args).toContain("--disable-blink-features=AutomationControlled");
    expect(launched.args).not.toContain("--headless=new");
    for (const tell of ["--enable-automation", "--use-mock-keychain", "--password-store=basic", "--disable-extensions"])
      expect(launched.args).not.toContain(tell);
    await opened.close();
    expect(sent).toEqual(["Browser.close"]);
    expect(launched.killed).toBeNull();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("headless only when asked, for reading the saved session", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stealth-"));
  try {
    const { launched, launch } = fakeChrome();
    const browser = { contexts: () => [{}], newBrowserCDPSession: async () => ({ send: async () => {} }) };
    await openStealthProfile(profile, true, { launch, connect: async () => browser });
    expect(launched.args).toContain("--headless=new");
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test("says to close the profile's window when Chrome hands over to one already open", async () => {
  const profile = await mkdtemp(join(tmpdir(), "stealth-"));
  try {
    const { launch } = fakeChrome({ handsOver: true });
    await expect(openStealthProfile(profile, false, { launch, connect: async () => ({}) })).rejects.toThrow(
      "Close the publisher's Chrome window",
    );
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
