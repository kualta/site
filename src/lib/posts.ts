import { fetchPublicationPosts, fetchPostBySlug } from "./paragraph";

export interface PostMetadata {
  title: string;
  description: string;
  date: string;
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
  return posts.map((post) => ({
    title: post.title,
    description: post.subtitle,
    date: new Date(Number(post.publishedAt)).toISOString().split("T")[0],
    tags: post.categories,
    filename: post.slug,
    preview: post.imageUrl || extractFirstImage(post.markdown ?? "") || "",
  }));
}

export async function getPostContent(slug: string) {
  const post = await fetchPostBySlug(slug);
  if (!post) return null;
  const markdown = post.markdown ?? "";
  const toc = markdown.split(/\r?\n/).filter((line) => line.startsWith("#"));
  const preview = post.imageUrl || extractFirstImage(markdown) || "";
  return {
    data: {
      title: post.title,
      description: post.subtitle,
      date: new Date(Number(post.publishedAt)).toISOString().split("T")[0],
      tags: post.categories,
      preview,
    },
    content: markdown,
    toc,
  };
}
