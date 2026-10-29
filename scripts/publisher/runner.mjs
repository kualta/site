import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { processMedia } from "./process.mjs";
import { publishAtproto } from "./atproto.mjs";
import { publishBrowser } from "./browser.mjs";

export async function publish(
  target,
  job,
  {
    api,
    oauth,
    stateDir,
    python,
    process = processMedia,
    atproto = publishAtproto,
    browser = publishBrowser,
  },
) {
  // Publish the version rendered and checked for this platform; jobs from before versions use the shared text.
  const variant = job.variants?.[target.platform];
  const post = variant ? { ...job, title: variant.title, caption: variant.text, tags: variant.tags } : job;
  const temp = await mkdtemp(join(tmpdir(), "kualta-post-"));
  // Text posts have no media.
  const kind = post.kind === "text" ? undefined : post.kind;
  let publishing = false;
  try {
    const files = [],
      infos = [];
    for (let i = 0; i < post.media.length; i++) {
      // Mixed posts say what each item is.
      const itemKind = post.mediaKinds?.[i] ?? kind;
      const input = join(temp, `source-${i}`),
        output = join(temp, `${i}.${itemKind === "photo" ? "jpg" : "mp4"}`);
      await writeFile(
        input,
        new Uint8Array(await (await api(`media/${post.media[i]}`)).arrayBuffer()),
      );
      const info = await process(input, output, {
        kind: itemKind,
        policy: post.metadata[target.platform],
        maxBytes: target.platform === "grain" ? 900_000 : 1_900_000,
      });
      await rm(input);
      files.push(output);
      infos.push(info);
    }
    if (
      kind === "video" &&
      target.platform === "bluesky" &&
      (infos[0].duration > 180 || infos[0].bytes > 100_000_000)
    )
      throw new Error("Bluesky video must be at most 3 minutes and 100 MB");
    const authorization = ["grain", "bluesky"].includes(target.platform)
      ? await oauth.agent()
      : null;
    publishing = true;
    let result;
    if (["grain", "bluesky"].includes(target.platform))
      result = await atproto(target.platform, authorization, files, infos, post);
    else if (["twitter", "instagram"].includes(target.platform)) {
      // Vendored adapters accept one path or an array for carousels; text posts send none.
      const media = files.length > 1 ? JSON.stringify(files) : (files[0] ?? "");
      result = await python(
        `${target.platform === "twitter" ? "x" : "instagram"}_browser_publish.py`,
        [
          "--user-data-dir",
          join(stateDir, target.platform),
          "--media",
          media,
          "--kind",
          kind === "photo" ? "image" : (kind ?? "none"),
          target.platform === "twitter" ? "--text" : "--caption",
          post.caption,
          "--headless",
          "false",
        ],
      );
      if (!result.ok)
        result = {
          uncertain: true,
          message: result.message || "Check the platform before retrying",
        };
    } else result = await browser(target.platform, join(stateDir, target.platform), files, post, infos);
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
