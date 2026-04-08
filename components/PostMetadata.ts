import { fetchPublicationPosts } from "@/lib/paragraph";

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

async function getPostsMetadata(): Promise<PostMetadata[]> {
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

export default getPostsMetadata;
