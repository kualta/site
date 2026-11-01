import { expect, test } from "bun:test";
import { groveUrl } from "./media-link";

const key = "a".repeat(64);
test("a link names a Grove file by its key, with the extension clients look for", () => {
  expect(groveUrl(`${key}.jpg`)).toBe(`https://api.grove.storage/${key}`);
  expect(groveUrl(`${key}.m3u8`)).toBe(`https://api.grove.storage/${key}`);
});
test("nothing else can be sent on through this site", () => {
  for (const file of ["", key, `${key}.png`, `${key}.jpg/../x`, `${"a".repeat(63)}.jpg`, `${"G".repeat(64)}.jpg`, "https://evil.example/x.jpg"])
    expect(groveUrl(file)).toBeNull();
});
