import { expect, test } from "bun:test";
import { exifDateTime, localDateTime } from "./photo-date";
test("preserves EXIF offsets when displaying capture time locally", () => {
  expect(exifDateTime("2021:07:18 09:30:10", "+03:00")).toBe(localDateTime(new Date("2021-07-18T06:30:10Z")));
  expect(exifDateTime("2021:07:18 09:30:10", undefined)).toBe("2021-07-18T09:30:10");
  expect(exifDateTime(undefined, undefined)).toBe("");
  expect(exifDateTime("invalid", undefined)).toBe("");
});
