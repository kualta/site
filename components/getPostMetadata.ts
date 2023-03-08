import { readdirSync, readFileSync } from "fs";
import matter from "gray-matter";
import PostMetadata from "./PostMetadata";

const getPostMetadata = (): PostMetadata[] => {
    const folder = "posts/";
    const files = readdirSync(folder);
    const mdPosts = files.filter((file) => file.endsWith('.md'));
    const posts = mdPosts.map((file) => {
        const fileContents = readFileSync(`${folder}${file}`, 'utf-8');
        const metadata = matter(fileContents);
        const slug = file.replace('.md', '');
        return {
            title: metadata.data.title,
            description: metadata.data.description,
            date: metadata.data.date,
            slug: slug
        } as PostMetadata;
    });

    return posts
}

export default getPostMetadata;