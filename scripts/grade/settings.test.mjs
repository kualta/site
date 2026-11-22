import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha, site } from "./offload.fixture.mjs";
import { saveSettings } from "./settings.mjs";

let root;
let paths;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "settings-"));
  paths = ["grades.json", "exports.json"].map((name) => join(root, name));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (name, text) => writeFileSync(join(root, name), text);

test("the settings are saved whole as _settings, and again only once they've changed", async () => {
  const request = site();
  write("grades.json", "the grades");
  write("exports.json", "the exports");
  write("ledger.json", "none of these");
  const first = await saveSettings(request, paths);
  const manifest = await request("projects/_settings");
  expect(manifest.files.map(({ path, sha256, size }) => [path, sha256, size])).toEqual([
    ["grades.json", sha("the grades"), 10],
    ["exports.json", sha("the exports"), 11],
  ]);
  expect(await (await request(`blobs/${sha("the grades")}`, { raw: true })).text()).toBe("the grades");

  // Unchanged: the archive isn't asked anything, by this run of the server or the next.
  const asked = request.asked.length;
  expect(await saveSettings(request, paths, first)).toBe(first);
  expect(request.asked).toHaveLength(asked);

  // Only what changed goes up again.
  write("grades.json", "graded since");
  const second = await saveSettings(request, paths, first);
  expect(second).not.toBe(first);
  const since = request.asked.slice(asked);
  expect(since.filter((what) => what.startsWith("PUT"))).toEqual([
    `PUT blobs/${sha("graded since")}`,
    "PUT projects/_settings",
  ]);
  expect((await request("projects/_settings")).files.map((file) => file.sha256)).toEqual([
    sha("graded since"),
    sha("the exports"),
  ]);
});

test("with no settings yet nothing is saved, and one not there yet is left out", async () => {
  const request = site();
  expect(await saveSettings(request, paths)).toBeNull();
  expect(request.asked).toEqual([]);
  write("grades.json", "the grades");
  await saveSettings(request, paths);
  expect((await request("projects/_settings")).files.map((file) => file.path)).toEqual(["grades.json"]);
});

test("settings the archive wouldn't take aren't counted as saved", async () => {
  const request = site({
    hold: (rest, init) =>
      rest === "projects/_settings" && init.method === "PUT"
        ? Promise.resolve(Response.json({ error: "Busy" }, { status: 400 }))
        : null,
  });
  write("grades.json", "the grades");
  await expect(saveSettings(request, paths)).rejects.toThrow("Busy");
});
