/**
 * One-time import of the Paragraph publication into in-repo MDX.
 *
 * Run by hand (`bun run posts:import`), never during the build: the posts now
 * live in src/content/posts and the site renders those. This exists so a post
 * drafted on Paragraph can still be pulled down, and so the import is
 * reproducible rather than a thing that happened once in someone's terminal.
 *
 * Images are mirrored into public/images/posts/<slug>/ — leaving them on
 * Paragraph's bucket would keep the dependency we are removing.
 */
import { mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentDir = path.join(root, "src/content/posts");
const imageRoot = path.join(root, "public/images/posts");

const API = "https://api.paragraph.com/api/v1";
const PUBLICATION = process.env.PARAGRAPH_PUBLICATION_SLUG || "kualta";
const force = process.argv.includes("--force");

/** frontmatter values are quoted, so any quote in the text has to be escaped */
function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function iso(timestamp, fallback) {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : fallback;
}

/**
 * MDX reads `{` and `<` as expression and element syntax, so prose that never
 * meant to be code has to be escaped or the file will not parse.
 */
function escapeMdx(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fenced = false;

  return lines
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;

      let out = "";
      let inCode = false;
      for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === "`") inCode = !inCode;
        if (!inCode && (char === "{" || char === "}")) {
          out += `\\${char}`;
          continue;
        }
        // a bare < that is not opening a tag or an autolink
        if (!inCode && char === "<" && !/^<\/?[A-Za-z][\w-]*[\s/>]|^<https?:/.test(line.slice(i))) {
          out += "&lt;";
          continue;
        }
        out += char;
      }
      return out;
    })
    .join("\n");
}

async function mirrorImage(url, slug) {
  const response = await fetch(url);
  if (!response.ok) {
    console.warn(`[posts] could not fetch ${url}: ${response.status}`);
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get("content-type") ?? "";
  const fromUrl = path.extname(new URL(url).pathname);
  const extension = fromUrl || (type.includes("png") ? ".png" : type.includes("gif") ? ".gif" : ".jpg");

  // the bucket names files by content hash; keep a short prefix of it
  const name = path.basename(new URL(url).pathname, fromUrl).slice(0, 12) + extension;
  const dir = path.join(imageRoot, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, name), buffer);

  return `/images/posts/${slug}/${name}`;
}

async function localise(markdown, slug) {
  const remote = [...new Set([...markdown.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))];
  let out = markdown;

  for (const url of remote) {
    const local = await mirrorImage(url, slug);
    if (local) out = out.split(url).join(local);
  }

  return { markdown: out, count: remote.length };
}

async function main() {
  const publication = await fetch(`${API}/publications/slug/${PUBLICATION}`);
  if (!publication.ok) throw new Error(`publication lookup failed: ${publication.status}`);
  const { id } = await publication.json();

  const response = await fetch(`${API}/publications/${id}/posts?includeContent=true`);
  if (!response.ok) throw new Error(`post fetch failed: ${response.status}`);
  const payload = await response.json();
  const posts = payload.items ?? payload;

  await mkdir(contentDir, { recursive: true });
  const existing = existsSync(contentDir) ? await readdir(contentDir) : [];

  for (const post of posts) {
    const file = path.join(contentDir, `${post.slug}.mdx`);
    if (existing.includes(`${post.slug}.mdx`) && !force) {
      console.log(`[posts] ${post.slug.padEnd(22)} already imported`);
      continue;
    }

    const published = iso(post.publishedAt, new Date().toISOString());
    const { markdown, count } = await localise(post.markdown ?? "", post.slug);
    const cover = post.imageUrl ? await mirrorImage(post.imageUrl, post.slug) : null;
    const preview = cover ?? markdown.match(/!\[[^\]]*\]\((\/[^)\s]+)\)/)?.[1] ?? "";

    const frontmatter = [
      "---",
      `title: ${yamlString(post.title)}`,
      `description: ${yamlString(post.subtitle ?? "")}`,
      `date: ${yamlString(published.split("T")[0])}`,
      `publishedTime: ${yamlString(published)}`,
      `modifiedTime: ${yamlString(iso(post.updatedAt, published))}`,
      `tags: [${(post.categories ?? []).map(yamlString).join(", ")}]`,
      `preview: ${yamlString(preview)}`,
      "---",
      "",
    ].join("\n");

    await writeFile(file, frontmatter + escapeMdx(markdown).trim() + "\n");
    console.log(`[posts] ${post.slug.padEnd(22)} imported (${count} image${count === 1 ? "" : "s"})`);
  }

  console.log(`[posts] ${posts.length} posts in ${path.relative(root, contentDir)}`);
}

await main();
