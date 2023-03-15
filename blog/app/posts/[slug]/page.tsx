import getPostMetadata from '@/components/getPostMetadata';
import { readFileSync } from 'fs';
import matter from 'gray-matter';
import Markdown from 'markdown-to-jsx';

const getPostContent = (slug: string) => {
    const folder = 'posts/';
    const file = `${folder}${slug}.md`;
    const content = readFileSync(file, 'utf-8');
    const post = matter(content);

    return post;
};

export const generateStaticParams = async () => {
    const posts = getPostMetadata();
    return posts.map((post) => ({
        slug: post.filename,
    }));
};

async function PostPage({ params }: { params: { slug: string } }) {
    const post = getPostContent(params.slug);

    return (
        <>
            <article className="prose dark:prose-invert prose-img:rounded-xl xl:prose-lg">
                <Markdown>{post.content}</Markdown>
            </article>
        </>
    );
}

export default PostPage;
