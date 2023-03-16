import { readdirSync, readFileSync } from 'fs';
import matter from 'gray-matter';

export interface PostMetadata {
    title: string;
    description: string;
    date: string;
    tags: string[];
    filename: string;
}

const getPostMetadata = (filter?: string): PostMetadata[] => {
    const path = process.env.POSTS_PATH || '/posts';
    const files = readdirSync(path);
    const markdownFiles = files.filter((file) => file.endsWith('.md'));

    const posts = markdownFiles
        .map((file) => {
            const fileContents = readFileSync(`${path}${file}`, 'utf-8');
            const metadata = matter(fileContents);
            const filename = file.replace('.md', '');

            if (filter && metadata.data.tags.indexOf(filter) === -1) {
                return null;
            }
            return {
                title: metadata.data.title,
                description: metadata.data.description,
                date: metadata.data.date,
                tags: metadata.data.tags,
                filename: filename,
            } as PostMetadata;
        })
        .filter((n) => n);

    // the cast is safe due to the filter call
    return posts as PostMetadata[];
};

export default getPostMetadata;
