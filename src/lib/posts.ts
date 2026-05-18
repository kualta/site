import { fetchPublicationPosts, fetchPostBySlug } from "./paragraph";

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

export async function getPostsMetadata(): Promise<PostMetadata[]> {
  const posts = await fetchPublicationPosts();
  return posts.map((post) => {
    const published = new Date(Number(post.publishedAt)).toISOString();
    const updated = post.updatedAt
      ? new Date(Number(post.updatedAt)).toISOString()
      : published;
    return {
      title: post.title,
      description: post.subtitle,
      date: published.split("T")[0],
      publishedTime: published,
      modifiedTime: updated,
      tags: post.categories,
      filename: post.slug,
      preview: post.imageUrl || extractFirstImage(post.markdown ?? "") || "",
    };
  });
}

export async function getPostContent(slug: string) {
  const post = await fetchPostBySlug(slug);
  if (!post) return null;
  const markdown = post.markdown ?? "";
  const toc = markdown.split(/\r?\n/).filter((line) => line.startsWith("#"));
  const preview = post.imageUrl || extractFirstImage(markdown) || "";
  const published = new Date(Number(post.publishedAt)).toISOString();
  const updated = post.updatedAt
    ? new Date(Number(post.updatedAt)).toISOString()
    : published;
  return {
    data: {
      title: post.title,
      description: post.subtitle,
      date: published.split("T")[0],
      publishedTime: published,
      modifiedTime: updated,
      tags: post.categories,
      preview,
    },
    content: markdown,
    toc,
  };
}
