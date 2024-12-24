import { readdirSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import path from "node:path";

export interface PostMetadata {
  title: string;
  description: string;
  date: string;
  tags: string[];
  filename: string;
  preview: string;
}

function getPostsMetadata(): PostMetadata[] {
  const postsPath = path.join(process.cwd(), "/posts/");
  const files = readdirSync(postsPath);
  const markdownFiles = files.filter((file) => file.endsWith(".md"));

  const posts = markdownFiles
    .map((file) => {
      const fileContents = readFileSync(`${postsPath}${file}`, "utf-8");
      const metadata = matter(fileContents);
      const filename = file.replace(".md", "");

      return {
        title: metadata.data.title,
        description: metadata.data.description,
        date: metadata.data.date,
        tags: metadata.data.tags,
        preview: metadata.data.preview,
        filename: filename,
      } as PostMetadata;
    })
    .sort((a, b) => {
      const first = Date.parse(a.date);
      const second = Date.parse(b.date);
      return second - first;
    });

  return posts;
}

export default getPostsMetadata;
