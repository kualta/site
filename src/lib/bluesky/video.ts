import type { ComposerAttachment } from "./media";

/** Blank optional metadata boxes without changing sample offsets in the MP4. */
export function stripMp4Metadata(source: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(source);
  const view = new DataView(bytes.buffer);
  function walk(start: number, end: number) {
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) throw new Error("Invalid video container.");
      let size = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) throw new Error("Invalid video container.");
        size = Number(view.getBigUint64(offset + 8));
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) throw new Error("Invalid video container.");
      if (["udta", "meta", "uuid", "free", "skip"].includes(type)) {
        bytes.set([102, 114, 101, 101], offset + 4);
        bytes.fill(0, offset + header, offset + size);
      } else if (["moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"].includes(type))
        walk(offset + header, offset + size);
      else if (["mvhd", "tkhd", "mdhd"].includes(type)) {
        const count = bytes[offset + header] === 1 ? 16 : 8;
        if (header + 4 + count > size) throw new Error("Invalid video timestamps.");
        bytes.fill(0, offset + header + 4, offset + header + 4 + count);
      }
      offset += size;
    }
  }
  walk(0, bytes.length);
  return bytes;
}

export async function sanitizeVideo(source: File): Promise<ComposerAttachment> {
  if (!["video/mp4", "video/quicktime", "video/webm"].includes(source.type))
    throw new Error("Choose an MP4, MOV, or WebM video.");
  if (source.size > 100_000_000) throw new Error("Choose a video under 100 MB.");
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ffmpeg = new FFmpeg();
  const urls: string[] = [];
  try {
    // Only the codec is downloaded. Media remains in the worker's in-memory filesystem.
    async function asset(name: string, type: string) {
      const response = await fetch(`https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/${name}`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error("Could not load the video processor.");
      const url = URL.createObjectURL(new Blob([await response.arrayBuffer()], { type }));
      urls.push(url);
      return url;
    }
    await ffmpeg.load(
      {
        coreURL: await asset("ffmpeg-core.js", "text/javascript"),
        wasmURL: await asset("ffmpeg-core.wasm", "application/wasm"),
      },
      { signal: AbortSignal.timeout(60_000) },
    );
    await ffmpeg.writeFile("input", new Uint8Array(await source.arrayBuffer()));
    // Probe in the worker so even unsupported browser codecs can be checked before transcoding.
    await ffmpeg.ffprobe(
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:packet=pts_time,duration_time",
        "-of",
        "json",
        "input",
        "-o",
        "probe.json",
      ],
      30_000,
    );
    const info = JSON.parse((await ffmpeg.readFile("probe.json", "utf8")) as string);
    const packetDuration = (info.packets ?? []).reduce(
      (max: number, packet: { pts_time?: string; duration_time?: string }) =>
        Math.max(max, Number(packet.pts_time ?? 0) + Number(packet.duration_time ?? 0)),
      0,
    );
    const duration = Number(info.format?.duration) || packetDuration;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180)
      throw new Error("Choose a video up to 3 minutes long.");
    const status = await ffmpeg.exec(
      [
        "-i",
        "input",
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-map_metadata",
        "-1",
        "-map_metadata:s",
        "-1",
        "-map_chapters",
        "-1",
        "-vf",
        "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "26",
        "-pix_fmt",
        "yuv420p",
        "-bsf:v",
        "filter_units=remove_types=6",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-metadata",
        "encoder=",
        "-metadata:s:v",
        "encoder=",
        "-metadata:s",
        "handler_name=",
        "-movflags",
        "+faststart",
        "output.mp4",
      ],
      180_000,
    );
    if (status !== 0) throw new Error("Video processing failed or timed out. Try a smaller video.");
    const output = await ffmpeg.readFile("output.mp4");
    if (typeof output === "string" || output.length > 100_000_000) throw new Error("Processed video exceeds 100 MB.");
    const clean = stripMp4Metadata(output);
    return {
      file: new File([clean.buffer as ArrayBuffer], `video-${crypto.randomUUID()}.mp4`, {
        type: "video/mp4",
        lastModified: 0,
      }),
      alt: "",
      width: 0,
      height: 0,
    };
  } finally {
    ffmpeg.terminate();
    urls.forEach((url) => URL.revokeObjectURL(url));
  }
}
