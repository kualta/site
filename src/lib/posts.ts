import { getCollection, getEntry, render } from "astro:content";
import type { CollectionEntry } from "astro:content";

export interface PostMetadata {
  title: string;
  description: string;
  date: string;
  publishedTime: string;
  modifiedTime: string;
  tags: string[];
  filename: string;
  preview: string;
}

function extractFirstImage(markdown: string): string | undefined {
  const match = markdown.match(/!\[.*?\]\((.*?)\)/);
  return match?.[1];
}

function toMetadata(entry: CollectionEntry<"posts">): PostMetadata {
  const published = entry.data.publishedTime ?? new Date(entry.data.date).toISOString();
  return {
    title: entry.data.title,
    description: entry.data.description,
    date: entry.data.date,
    publishedTime: published,
    modifiedTime: entry.data.modifiedTime ?? published,
    tags: entry.data.tags,
    filename: entry.id,
    preview: entry.data.preview || extractFirstImage(entry.body ?? "") || "",
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
