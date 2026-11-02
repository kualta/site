import { describe, expect, test } from "bun:test";
import { describeProgress, readWithProgress } from "./download";

function streamed(parts: string[], headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { headers });
}

describe("readWithProgress", () => {
  test("reports each chunk against the Content-Length and keeps the type", async () => {
    const seen: [number, number | undefined][] = [];
    const blob = await readWithProgress(
      streamed(["abc", "defg"], { "Content-Length": "7", "Content-Type": "video/mp4" }),
      (loaded, total) => seen.push([loaded, total]),
    );
    expect(seen).toEqual([
      [0, 7],
      [3, 7],
      [7, 7],
    ]);
    expect(blob.type).toBe("video/mp4");
    expect(await blob.text()).toBe("abcdefg");
  });

  test("counts bytes without a total when the length is missing", async () => {
    const seen: (number | undefined)[] = [];
    const blob = await readWithProgress(streamed(["ab", "c"]), (_, total) => seen.push(total));
    expect(seen.every((total) => total === undefined)).toBe(true);
    expect(blob.size).toBe(3);
  });
});

describe("describeProgress", () => {
  test("shows megabytes against the total", () => {
    expect(describeProgress(45_200_000, 81_000_000)).toBe("45 of 81 MB");
    expect(describeProgress(2_340_000, 81_000_000)).toBe("2.3 of 81 MB");
  });

  test("shows what arrived without a total", () => {
    expect(describeProgress(12_600_000)).toBe("13 MB");
  });
});
