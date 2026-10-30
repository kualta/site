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
    signal,
  },
) {
  // Publish the version rendered and checked for this platform; jobs from before versions use the shared text.
  const variant = job.variants?.[target.platform];
  const post = variant ? { ...job, title: variant.title, caption: variant.text, tags: variant.tags } : job;
  const temp = await mkdtemp(join(tmpdir(), "kualta-post-"));
  // Text posts have no media.
  const kind = post.kind === "text" ? undefined : post.kind;
  // Every other destination keeps the original frame.
  const vertical = target.platform === "youtube" && post.youtubeShort === true;
  let publishing = false;
  // Stopping ends the attempt at once, even during a step that can't be interrupted.
  const stopped = new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("Stopped")), { once: true });
  });
  stopped.catch(() => {});
  const until = (work) => Promise.race([work, stopped]);
  try {
    const files = [],
      infos = [];
    for (let i = 0; i < post.media.length; i++) {
      // Mixed posts say what each item is.
      const itemKind = post.mediaKinds?.[i] ?? kind;
      const input = join(temp, `source-${i}`),
        output = join(temp, `${i}.${itemKind === "photo" ? "jpg" : "mp4"}`);
      const source = await until(api(`media/${post.media[i]}`).then((response) => response.arrayBuffer()));
      await writeFile(input, new Uint8Array(source));
      const info = await until(process(input, output, {
        kind: itemKind,
        policy: post.metadata[target.platform],
        maxBytes: target.platform === "grain" ? 900_000 : 1_900_000,
        vertical,
        signal,
      }));
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
    if (vertical && infos[0].duration > 180)
      throw new Error(
        "A YouTube Short must be at most 3 minutes. Nothing was uploaded; post it again without Post as a Short.",
      );
    const authorization = ["grain", "bluesky"].includes(target.platform)
      ? await oauth.agent()
      : null;
    publishing = true;
    let result;
    if (["grain", "bluesky"].includes(target.platform))
      result = await until(atproto(target.platform, authorization, files, infos, post));
    else if (["twitter", "instagram"].includes(target.platform)) {
      // Vendored adapters accept one path or an array for carousels; text posts send none.
      const media = files.length > 1 ? JSON.stringify(files) : (files[0] ?? "");
      result = await until(python(
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
        signal,
      ));
      if (!result.ok)
        result = {
          uncertain: true,
          message: result.message || "Check the platform before retrying",
        };
    } else result = await until(browser(target.platform, join(stateDir, target.platform), files, post, infos, signal));
    return {
      state: result.url && !result.uncertain ? "succeeded" : "uncertain",
      url: result.url,
      message: result.message || "",
    };
  } catch (e) {
    return { state: publishing ? "uncertain" : "failed", message: e.message };
  } finally {
    // A stopped step may still be writing here; the system clears its temp folder eventually.
    await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
