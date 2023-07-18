import { readFileSync } from "fs";
import matter from "gray-matter";
import path from "path";

const getPostContent = (slug: string) => {
  const postsPath = path.join(process.cwd(), "/posts/");
  const file = `${postsPath}${slug}.md`;
  const content = readFileSync(file, "utf-8");
  const post = matter(content);

  return post;
};

export default getPostContent;
