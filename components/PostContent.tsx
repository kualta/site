import { fetchPostBySlug } from "@/lib/paragraph";

function extractFirstImage(markdown: string): string | undefined {
  const match = markdown.match(/!\[.*?\]\((.*?)\)/);
  return match?.[1];
}

export const getPostContent = async (slug: string) => {
  const post = await fetchPostBySlug(slug);
  const markdown = post.markdown ?? "";

  const toc = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#"));

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
};
