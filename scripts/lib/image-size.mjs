/**
 * Reads pixel dimensions straight out of an image header.
 *
 * The site ships its images from `public/`, so Astro never touches them and
 * never learns how big they are. That is how `og:image:width` came to claim
 * 1200x630 for files that are 2048x1152, and how every in-post image shipped
 * without width/height and shifted the page as it loaded.
 *
 * Header-only, no decoding, no dependency: this runs at build time for every
 * image on the site and must stay cheap.
 */
import { openSync, readSync, closeSync, statSync } from "node:fs";

/** enough for a PNG/GIF/WebP/AVIF header and a good stretch of JPEG segments */
const HEAD_BYTES = 65536;

function head(file) {
  const size = Math.min(statSync(file).size, HEAD_BYTES);
  const buffer = Buffer.alloc(size);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function png(buffer) {
  // IHDR is always the first chunk, width and height right behind its name
  if (buffer.readUInt32BE(12) !== 0x49484452) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function gif(buffer) {
  return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
}

function jpeg(buffer) {
  // walk the segment chain to the frame header, which is the only place the
  // real dimensions live; thumbnails in EXIF would otherwise win
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // SOF0..SOF15, minus the four that are not frame headers
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}

function webp(buffer) {
  const format = buffer.toString("ascii", 12, 16);
  if (format === "VP8 ") {
    return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (format === "VP8L") {
    const bits = buffer.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (format === "VP8X") {
    const read24 = (at) => buffer[at] | (buffer[at + 1] << 8) | (buffer[at + 2] << 16);
    return { width: read24(24) + 1, height: read24(27) + 1 };
  }
  return null;
}

/** ISO base media boxes: avif and heic keep their size in an `ispe` box */
function isoBmff(buffer) {
  let best = null;

  const walk = (start, end) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = buffer.toString("ascii", offset + 4, offset + 8);
      let header = 8;
      if (size === 1) {
        // 64-bit size; the high word is zero for anything we will ever ship
        size = buffer.readUInt32BE(offset + 12);
        header = 16;
      }
      if (size === 0) size = end - offset;
      if (size < header || offset + size > end) return;

      if (type === "ispe") {
        const width = buffer.readUInt32BE(offset + 12);
        const height = buffer.readUInt32BE(offset + 16);
        // several ispe boxes can appear (thumbnails, alpha planes); the image
        // itself is the biggest of them
        if (!best || width * height > best.width * best.height) best = { width, height };
      } else if (["meta", "iprp", "ipco"].includes(type)) {
        // meta carries a version/flags word before its children
        walk(offset + header + (type === "meta" ? 4 : 0), offset + size);
      }
      offset += size;
    }
  };

  walk(0, buffer.length);
  return best;
}

function svg(buffer) {
  const source = buffer.toString("utf8", 0, Math.min(buffer.length, 4096));
  const tag = source.match(/<svg[^>]*>/i)?.[0];
  if (!tag) return null;

  const attr = (name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
  const number = (value) => {
    const parsed = Number.parseFloat(value ?? "");
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  };

  const width = number(attr("width"));
  const height = number(attr("height"));
  if (width && height) return { width, height };

  // no intrinsic size, so the viewBox is the only aspect ratio on offer
  const box = attr("viewBox")
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (box?.length === 4 && box.every(Number.isFinite)) {
    return { width: Math.round(box[2]), height: Math.round(box[3]) };
  }
  return null;
}

/**
 * @param {string} file absolute path to an image
 * @returns {{width: number, height: number} | null} null when the format is
 *   unknown or the header is malformed. Callers fall back to shipping no
 *   dimensions at all, which is what happened before this existed
 */
export function imageSize(file) {
  let buffer;
  try {
    buffer = head(file);
  } catch {
    return null;
  }
  if (buffer.length < 16) return null;

  try {
    if (buffer.readUInt32BE(0) === 0x89504e47) return png(buffer);
    if (buffer.toString("ascii", 0, 3) === "GIF") return gif(buffer);
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return jpeg(buffer);
    if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
      return webp(buffer);
    }
    if (buffer.toString("ascii", 4, 8) === "ftyp") return isoBmff(buffer);
    if (/^\s*(<\?xml|<svg)/i.test(buffer.toString("utf8", 0, 64))) return svg(buffer);
  } catch {
    return null;
  }
  return null;
}
