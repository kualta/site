import { RichText } from "@atproto/api";
import { readFile } from "node:fs/promises";
import { recordKey } from "../lib/atproto-content.mjs";
const owner = "did:plc:jhvnnnd3adml7t6anu3ay7ip";

export async function publishAtproto(platform, authorization, files, infos, post, options = {}) {
  const agent = authorization.agent;
  const fetcher = options.fetcher || fetch;
  const wait = options.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (agent.did !== owner) throw new Error("The AT Protocol account must belong to kualta");
  const createdAt = new Date().toISOString();
  const blobs = [];
  if (post.kind === "photo") {
    for (const file of files)
      blobs.push(
        (
          await agent.uploadBlob(new Uint8Array(await readFile(file)), {
            encoding: "image/jpeg",
          })
        ).data.blob,
      );
  }
  if (platform === "grain") {
    const rkey = recordKey(`publisher:grain:${post.id}`);
    const gallery = `at://${owner}/social.grain.gallery/${rkey}`;
    const writes = [
      {
        $type: "com.atproto.repo.applyWrites#create",
        collection: "social.grain.gallery",
        rkey,
        value: {
          $type: "social.grain.gallery",
          title: post.title,
          description: post.caption,
          createdAt,
        },
      },
    ];
    for (let i = 0; i < blobs.length; i++) {
      const photoKey = recordKey(`publisher:grain:${post.id}:${i}`);
      writes.push({
        $type: "com.atproto.repo.applyWrites#create",
        collection: "social.grain.photo",
        rkey: photoKey,
        value: {
          $type: "social.grain.photo",
          photo: blobs[i],
          alt: post.alt,
          aspectRatio: { width: infos[i].width, height: infos[i].height },
          createdAt,
        },
      });
      writes.push({
        $type: "com.atproto.repo.applyWrites#create",
        collection: "social.grain.gallery.item",
        rkey: photoKey,
        value: {
          $type: "social.grain.gallery.item",
          gallery,
          item: `at://${owner}/social.grain.photo/${photoKey}`,
          position: i,
          createdAt,
        },
      });
    }
    await agent.com.atproto.repo.applyWrites({
      repo: owner,
      validate: false,
      writes,
    });
    return { url: `https://grain.social/profile/${owner}/gallery/${rkey}` };
  }
  let embed;
  if (post.kind === "photo")
    embed = {
      $type: "app.bsky.embed.images",
      images: blobs.map((image, i) => ({
        image,
        alt: post.alt,
        aspectRatio: { width: infos[i].width, height: infos[i].height },
      })),
    };
  else {
    const { data: auth } = await agent.com.atproto.server.getServiceAuth({
      aud: `did:web:${authorization.pdsUrl.host}`,
      lxm: "com.atproto.repo.uploadBlob",
      exp: Math.floor(Date.now() / 1000) + 1800,
    });
    const query = new URLSearchParams({ did: owner, name: `${post.id}.mp4` });
    const response = await fetcher(
      `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?${query}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "video/mp4",
        },
        body: await readFile(files[0]),
      },
    );
    let job = await response.json();
    job = job.jobStatus || job;
    if (!response.ok && !job.blob && !job.jobId)
      throw new Error(`Bluesky video upload failed (${response.status})`);
    for (let attempt = 0; !job.blob && attempt < 180; attempt++) {
      if (job.error || job.state === "JOB_STATE_FAILED")
        throw new Error("Bluesky video processing failed");
      await wait(5000);
      const response = await fetcher(
        `https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${encodeURIComponent(
          job.jobId,
        )}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!response.ok) throw new Error("Bluesky video status unavailable");
      job = (await response.json()).jobStatus;
    }
    if (!job.blob) throw new Error("Bluesky video processing timed out");
    embed = {
      $type: "app.bsky.embed.video",
      video: job.blob,
      alt: post.alt,
      aspectRatio: { width: infos[0].width, height: infos[0].height },
    };
  }
  const rich = new RichText({ text: post.caption });
  await rich.detectFacets(agent);
  const rkey = recordKey(`publisher:bluesky:${post.id}`);
  await agent.com.atproto.repo.createRecord({
    repo: owner,
    collection: "app.bsky.feed.post",
    rkey,
    record: {
      $type: "app.bsky.feed.post",
      text: rich.text,
      facets: rich.facets,
      embed,
      createdAt,
    },
  });
  return { url: `https://bsky.app/profile/${owner}/post/${rkey}` };
}
