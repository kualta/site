// Files for films: what ffprobe says of a clip, and copies that cost no disk.
import { execFile } from "node:child_process";
import { copyFile, constants, stat, utimes } from "node:fs/promises";
import { promisify } from "node:util";
import ffprobeStatic from "ffprobe-static";

const exec = promisify(execFile);
const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

/**
 * A clip's length, its picture's size (as shown, so a clip turned 90° has its sides swapped), its frame rate as
 * `{ num, den }`, and `first`: its first frame's own time, where its seconds count from.
 */
export async function probe(file) {
  const { stdout } = await exec(FFPROBE, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const info = JSON.parse(stdout);
  const v = info.streams?.find((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const rotation = v?.side_data_list?.find((d) => d.rotation != null)?.rotation ?? v?.tags?.rotate ?? 0;
  let width = v?.width ?? 0;
  let height = v?.height ?? 0;
  if (Math.abs(Number(rotation)) % 180 === 90) [width, height] = [height, width];
  const [num, den] = String(v?.r_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  return {
    duration: Number(info.format?.duration) || 0,
    width,
    height,
    rate: num > 0 && den > 0 ? { num, den } : null,
    first: Number(v?.start_time) || 0,
  };
}

/** A file's stat, or null when there's none. */
export const statOf = (path) => stat(path).catch(() => null);

/**
 * A copy of `from` at `to` that shares its blocks (APFS clonefile, as `cp -c`), with its times. Node's own copyFile
 * copies every byte here even when asked to clone, so on macOS `cp` makes it. Elsewhere (CI) it's a plain copy.
 */
export async function clone(from, to) {
  if (process.platform === "darwin") {
    await exec("/bin/cp", ["-cp", from, to]);
    return;
  }
  await copyFile(from, to, constants.COPYFILE_FICLONE);
  const { atime, mtime } = await stat(from);
  await utimes(to, atime, mtime);
}

/** The frame rate as `openfilm render --fps` takes it: 59.94 for 60000/1001. */
export const fpsOf = (rate) => String(Number((rate.num / rate.den).toFixed(3)));
