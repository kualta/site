import { readFileSync } from 'fs';
import matter from 'gray-matter';

const getPostContent = (slug: string) => {
    const path = process.env.POSTS_PATH || 'posts/';
    const file = `${path}${slug}.md`;
    const content = readFileSync(file, 'utf-8');
    const post = matter(content);

    return post;
};

export default getPostContent;