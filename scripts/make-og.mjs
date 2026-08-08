/**
 * Draws a share card for every record and writes it to public/music/og.
 *
 * Run this by hand when adding music (`bun run music:og`), not during the build.
 * The cards are committed: text is drawn with whatever fonts the machine has, and
 * a build server has no Japanese ones, so generating them in CI would produce tofu.
 *
 * The artwork comes out of the MP3 itself, the same source sync-music.mjs uses.
 */
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile, selectCover } from "music-metadata";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const audioDir = path.join(root, "public/music");
const outDir = path.join(audioDir, "og");

const WIDTH = 1200;
const HEIGHT = 630;
const ART = 400;
const ART_X = 100;
const ART_Y = (HEIGHT - ART) / 2;
const TEXT_X = ART_X + ART + 60;
const TEXT_W = WIDTH - TEXT_X - 80;

// the rounded 1c stack the site uses is not installed, so fall back to whatever
// the machine has that covers Latin, Cyrillic and Japanese alike
const FONTS = "'Hiragino Maru Gothic ProN','Hiragino Sans','Helvetica Neue',Arial,sans-serif";

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const escape = (text) =>
  text.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);

/** full-width scripts cost about a whole em each, Latin roughly half */
const widthOf = (text, size) =>
  [...text].reduce((total, char) => total + (/[　-鿿＀-￯]/.test(char) ? size : size * 0.54), 0);

/** shrink to fit the column, and only clip once it is already as small as it should go */
function fit(text, size, min) {
  let current = size;
  while (current > min && widthOf(text, current) > TEXT_W) current -= 2;
  if (widthOf(text, current) <= TEXT_W) return { text, size: current };

  let clipped = text;
  while (clipped.length > 1 && widthOf(`${clipped}…`, current) > TEXT_W) clipped = clipped.slice(0, -1);
  return { text: `${clipped}…`, size: current };
}

async function card(cover, track) {
  const art = await sharp(cover).resize(ART, ART, { fit: "cover" }).toBuffer();
  const rounded = await sharp(art)
    .composite([
      {
        input: Buffer.from(`<svg width="${ART}" height="${ART}"><rect width="${ART}" height="${ART}" rx="24"/></svg>`),
        blend: "dest-in",
      },
    ])
    .toBuffer();

  // the record's own colours carry the card, pushed back far enough to read over
  const background = await sharp(cover)
    .resize(WIDTH, HEIGHT, { fit: "cover" })
    .blur(60)
    .modulate({ brightness: 0.42, saturation: 1.1 })
    .toBuffer();

  const title = fit(track.title, 62, 34);
  const byline = fit(track.byline, 30, 22);
  const meta = fit(track.meta, 26, 20);

  const text = `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${WIDTH}" height="${HEIGHT}" fill="#0b0b0c" fill-opacity="0.46"/>
    <g font-family="${FONTS}" fill="#f5f5f4">
      <text x="${TEXT_X}" y="296" font-size="${title.size}" font-weight="600">${escape(title.text)}</text>
      <text x="${TEXT_X}" y="352" font-size="${byline.size}" fill="#d4d4d8">${escape(byline.text)}</text>
      <text x="${TEXT_X}" y="396" font-size="${meta.size}" fill="#a1a1aa">${escape(meta.text)}</text>
      <text x="${WIDTH - 80}" y="${HEIGHT - 54}" font-size="24" fill="#8b8b93" text-anchor="end">kualta.dev</text>
    </g>
  </svg>`;

  return sharp(background)
    .composite([
      { input: Buffer.from(text), top: 0, left: 0 },
      { input: rounded, top: Math.round(ART_Y), left: ART_X },
    ])
    .png()
    .toBuffer();
}

async function main() {
  if (!existsSync(audioDir)) return;
  await mkdir(outDir, { recursive: true });

  const files = (await readdir(audioDir)).filter((file) => file.endsWith(".mp3")).sort();
  let drawn = 0;
  let skipped = 0;

  for (const file of files) {
    const slug = slugify(path.basename(file, ".mp3"));
    const { common } = await parseFile(path.join(audioDir, file));
    const picture = selectCover(common.picture);

    if (!picture) {
      skipped += 1;
      console.log(`[og] ${slug.padEnd(22)} no artwork, skipped`);
      continue;
    }

    // a cover credits whoever wrote it; an original just names the artist
    const artist = common.artist ?? "kualta";
    const byline = common.originalartist ? `${artist} · ${common.originalartist}` : artist;
    const meta = [common.album, common.year].filter(Boolean).join(" · ");

    const png = await card(picture.data, { title: common.title ?? slug, byline, meta });
    await writeFile(path.join(outDir, `${slug}.png`), png);

    drawn += 1;
    console.log(`[og] ${slug.padEnd(22)} ${String(Math.round(png.length / 1024)).padStart(4)}kb`);
  }

  console.log(`[og] ${drawn} cards written to public/music/og, ${skipped} skipped`);
}

await main();
