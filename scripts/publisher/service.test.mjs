import { expect, test } from "bun:test";
import { launchAgent, label } from "./service.mjs";

test("launch agent runs the helper from the checkout and keeps it alive", () => {
  const plist = launchAgent({
    node: "/opt/node/bin/node",
    root: "/Users/me/R&D <site>",
    path: "/opt/homebrew/bin:/usr/bin",
    log: "/Users/me/site/.publisher/helper.log",
  });
  expect(plist).toContain(`<key>Label</key><string>${label}</string>`);
  expect(plist).toContain(
    "<array><string>/opt/node/bin/node</string><string>/Users/me/R&amp;D &lt;site&gt;/scripts/publisher/cli.mjs</string><string>start</string></array>",
  );
  expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/me/R&amp;D &lt;site&gt;</string>");
  expect(plist).toContain("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>");
  expect(plist).toContain("<key>KeepAlive</key><true/>");
  expect(plist).toContain("<key>StandardErrorPath</key><string>/Users/me/site/.publisher/helper.log</string>");
});
