import { expect, test, spyOn } from "bun:test";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { openProfile } from "./browser.mjs";

test("session checks and browser actions reopen Chrome with its native credential store", async () => {
  const context = {};
  const launch = spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
  try {
    expect(await openProfile("/tmp/test-profile")).toBe(context);
    expect(launch).toHaveBeenCalledWith(
      "/tmp/test-profile",
      expect.objectContaining({
        channel: "chrome",
        ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
      }),
    );
  } finally {
    launch.mockRestore();
  }
});

test("X and Instagram adapters use the same native store and never silently fall back", () => {
  execFileSync("python3", [
    "-c",
    `
import sys, tempfile
from types import SimpleNamespace
sys.path.insert(0, "scripts/publisher/vendor")
import x_browser_lib, instagram_browser_lib
for module in [x_browser_lib, instagram_browser_lib]:
    calls = []
    def launch(path, **options):
        calls.append(options)
        return options
    with tempfile.TemporaryDirectory() as path:
        browser = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
        result = module.launch_persistent(browser, path, False)
        assert result["channel"] == "chrome"
        assert result["ignore_default_args"] == ["--use-mock-keychain", "--password-store=basic"]
        def fail(path, **options):
            calls.append(options)
            raise RuntimeError("Chrome unavailable")
        browser.chromium.launch_persistent_context = fail
        calls.clear()
        try:
            module.launch_persistent(browser, path, False)
            raise AssertionError("must fail")
        except RuntimeError:
            assert len(calls) == 1
            assert calls[0]["channel"] == "chrome"
`,
  ]);
});
