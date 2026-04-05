import { fetchPostBySlug } from "@/lib/paragraph";

export const getPostContent = async (slug: string) => {
  const post = await fetchPostBySlug(slug);
  const markdown = post.markdown ?? "";

  const toc = markdown
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#"));

  return {
    data: {
      title: post.title,
      description: post.subtitle,
      date: new Date(Number(post.publishedAt)).toISOString().split("T")[0],
      tags: post.categories,
      preview: post.imageUrl,
    },
    content: markdown,
    toc,
  };
};
