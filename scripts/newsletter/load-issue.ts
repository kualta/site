import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parseIssue } from "../../src/lib/newsletter/issues";

// Read the same Markdown body published by Astro; never execute MDX in an email.
export async function loadIssue(file: string) {
  const source = await readFile(file, "utf8");
  if (file.endsWith(".json")) return parseIssue(JSON.parse(source));
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error("Post needs YAML frontmatter.");
  const [, frontmatter, body] = match;
  function field(name: string) {
    const value = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
    if (!value) return "";
    return value.startsWith('"') ? (JSON.parse(value) as string) : value.replace(/^'|'$/g, "");
  }
  if (/^\s*(import|export)\s/m.test(body) || /<[A-Za-z!/]/.test(body))
    throw new Error("Email posts must use Markdown, not HTML or MDX components. Supply an email Markdown version.");
  const id = basename(file).replace(/\.mdx?$/, "");
  // Site-relative inline and reference URLs must remain usable outside the site.
  const markdown = body
    .replace(/(\]\()\/(?!\/)/g, "$1https://kualta.dev/")
    .replace(/^(\s*\[[^\]]+\]:\s*)\/(?!\/)/gm, "$1https://kualta.dev/");
  return parseIssue({
    id,
    title: field("title"),
    preview: field("description"),
    markdown,
    articleUrl: `https://kualta.dev/posts/${id}`,
  });
}
