import { getCollection, getEntry, render } from "astro:content";
import type { CollectionEntry } from "astro:content";

export interface PostMetadata {
  title: string;
  description: string;
  /** the meta-description length version of `description`, which is a subtitle */
  summary: string;
  date: string;
  publishedTime: string;
  modifiedTime: string;
  tags: string[];
  filename: string;
  preview: string;
  wordCount: number;
}

function extractFirstImage(markdown: string): string | undefined {
  const match = markdown.match(/!\[.*?\]\((.*?)\)/);
  return match?.[1];
}

/** the body as a reader sees it: no frontmatter, no syntax, no images */
function toPlainText(markdown: string): string {
  return markdown
    .replace(/^---[\s\S]*?---/, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*>+\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[=-]{3,}\s*$/gm, " ")
    .replace(/[*_`~\\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subtitles on these posts are four words long ("on suffering"), which
 * reads well under a title and is far too thin to be a search result. A post can
 * carry its own `summary`; otherwise the opening lines stand in, cut to the
 * length a result actually shows.
 */
function toSummary(entry: CollectionEntry<"posts">, plain: string): string {
  const authored = entry.data.summary?.trim();
  if (authored) return authored;

  const subtitle = entry.data.description?.trim();
  const opening = plain.slice(0, 400);
  const lead = subtitle ? `${entry.data.title}: ${subtitle}. ${opening}` : opening;

  if (lead.length <= 158) return lead;
  const cut = lead.slice(0, 158);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "")}…`;
}

function toMetadata(entry: CollectionEntry<"posts">): PostMetadata {
  const published = entry.data.publishedTime ?? new Date(entry.data.date).toISOString();
  const body = entry.body ?? "";
  const plain = toPlainText(body);

  return {
    title: entry.data.title,
    description: entry.data.description,
    summary: toSummary(entry, plain),
    date: entry.data.date,
    publishedTime: published,
    modifiedTime: entry.data.modifiedTime ?? published,
    tags: entry.data.tags,
    filename: entry.id,
    preview: entry.data.preview || extractFirstImage(body) || "",
    wordCount: plain ? plain.split(" ").length : 0,
  };
}

/** newest first, drafts left out of the build */
export async function getPosts(): Promise<CollectionEntry<"posts">[]> {
  const posts = await getCollection("posts", ({ data }) => !data.draft);
  return posts.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export async function getPostsMetadata(): Promise<PostMetadata[]> {
  return (await getPosts()).map(toMetadata);
}

export async function getPostContent(slug: string) {
  const entry = await getEntry("posts", slug);
  if (!entry || entry.data.draft) return null;

  const { Content, headings } = await render(entry);
  return { data: toMetadata(entry), entry, Content, headings };
}
