import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processMedia } from "./process.mjs";
import { publishAtproto } from "./atproto.mjs";
import { publishBrowser } from "./browser.mjs";

export async function publish(
  target,
  post,
  {
    api,
    config,
    stateDir,
    python,
    process = processMedia,
    atproto = publishAtproto,
    browser = publishBrowser,
  },
) {
  const temp = await mkdtemp(join(tmpdir(), "kualta-post-"));
  let publishing = false;
  try {
    const files = [],
      infos = [];
    for (let i = 0; i < post.media.length; i++) {
      const input = join(temp, `source-${i}`),
        output = join(temp, `${i}.${post.kind === "photo" ? "jpg" : "mp4"}`);
      await writeFile(input, new Uint8Array(await (await api(`media/${post.media[i]}`)).arrayBuffer()));
      const info = await process(input, output, {
        kind: post.kind,
        policy: post.metadata[target.platform],
        maxBytes: target.platform === "grain" ? 900_000 : 1_900_000,
      });
      await rm(input);
      files.push(output);
      infos.push(info);
    }
    if (
      post.kind === "video" &&
      target.platform === "bluesky" &&
      (infos[0].duration > 180 || infos[0].bytes > 100_000_000)
    )
      throw new Error("Bluesky video must be at most 3 minutes and 100 MB");
    publishing = true;
    let result;
    if (["grain", "bluesky"].includes(target.platform))
      result = await atproto(target.platform, config.atproto, files, infos, post);
    else if (["twitter", "instagram"].includes(target.platform)) {
      // Vendored adapters accept one path or an array for carousels.
      const media = files.length === 1 ? files[0] : JSON.stringify(files);
      result = await python(`${target.platform === "twitter" ? "x" : "instagram"}_browser_publish.py`, [
        "--user-data-dir",
        join(stateDir, target.platform),
        "--media",
        media,
        "--kind",
        post.kind === "photo" ? "image" : "video",
        target.platform === "twitter" ? "--text" : "--caption",
        post.caption,
        "--headless",
        "false",
      ]);
      if (!result.ok)
        result = { uncertain: true, message: result.message || "Check the platform before retrying" };
    } else result = await browser(target.platform, join(stateDir, target.platform), files, post);
    return {
      state: result.url && !result.uncertain ? "succeeded" : "uncertain",
      url: result.url,
      message: result.message || "",
    };
  } catch (e) {
    return { state: publishing ? "uncertain" : "failed", message: e.message };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
