import { readFileSync } from "fs";
import matter from "gray-matter";
import path from "path";

export const getPostContent = (slug: string) => {
  const postsPath = path.join(process.cwd(), "/posts/");
  const file = `${postsPath}${slug}.md`;
  const content = readFileSync(file, "utf-8");
  const post = matter(content);
  const toc = post.content
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("#")) {
        return line;
      }
      return null;
    })
    .filter((line) => line !== null);

  return {
    ...post,
    toc,
  };
};
