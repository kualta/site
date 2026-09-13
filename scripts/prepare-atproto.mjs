import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { validateRecord } from "./lib/atproto-validation.mjs";
import { articleRecord, publicationUri } from "./lib/atproto-content.mjs";

export async function prepare(root = process.cwd()) {
  const config = JSON.parse(await readFile(path.join(root, "atproto.config.json"), "utf8"));
  const sourceDir = path.join(root, "src/content/posts");
  const documents = [];
  for (const file of (await readdir(sourceDir, { recursive: true })).sort()) {
    if (!/\.mdx?$/.test(file)) continue;
    const slug = file.replace(/\.mdx?$/, "");
    if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(slug))
      throw new Error(`Use a lowercase kebab-case article path: ${file}`);
    const document = articleRecord(config, slug, await readFile(path.join(sourceDir, file), "utf8"));
    if (!document) continue;
    if (document.preview) {
      const url = new URL(document.preview, config.url);
      if (url.origin !== config.url) throw new Error(`${slug}: use a local cover image`);
      const publicDir = path.resolve(root, "public");
      const imagePath = path.resolve(publicDir, `.${decodeURIComponent(url.pathname)}`);
      if (!imagePath.startsWith(`${publicDir}${path.sep}`)) throw new Error("Cover escapes public directory");
      const bytes = await sharp(imagePath)
        .rotate()
        .resize({ width: 1200, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
      if (bytes.length >= 1_000_000) throw new Error(`${slug}: cover exceeds 1 MB`);
      document.cover = { mimeType: "image/webp", base64: bytes.toString("base64") };
    }
    delete document.preview;
    documents.push(document);
  }
  if (new Set(documents.map((doc) => doc.uri)).size !== documents.length)
    throw new Error("Duplicate article record keys");
  const manifest = {
    version: 1,
    did: config.did,
    publication: {
      uri: publicationUri(config),
      record: {
        $type: "site.standard.publication",
        url: config.url,
        name: config.name,
        description: config.description,
        preferences: { showInDiscover: true },
      },
    },
    documents,
  };
  validateRecord(manifest.publication.record);
  for (const document of documents) validateRecord(document.record);
  const output = path.join(root, "public/.well-known");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "site.standard.publication"), `${manifest.publication.uri}\n`);
  await writeFile(path.join(output, "site.standard.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared ${documents.length} Standard.site articles`);
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) await prepare();
