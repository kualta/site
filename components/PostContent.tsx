import { readFileSync } from 'fs';
import matter from 'gray-matter';

const getPostContent = (slug: string) => {
    const folder = 'posts/';
    const file = `${folder}${slug}.md`;
    const content = readFileSync(file, 'utf-8');
    const post = matter(content);

    return post;
};

export default getPostContent;