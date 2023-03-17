import getPostMetadata from '@/components/PostMetadata';
import getPostContent from '@/components/PostContent';
import Markdown from 'markdown-to-jsx';

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
            <article className="py-8 prose dark:prose-invert prose-img:rounded-xl xl:prose-lg">
                <Markdown>{post.content}</Markdown>
            </article>
        </>
    );
}

export default PostPage;
