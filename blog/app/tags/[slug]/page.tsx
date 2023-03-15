import PostPreview from '@/components/PostPreview';
import getPostMetadata from '@/components/PostMetadata';

export const generateStaticParams = async () => {
    const posts = getPostMetadata();
    return posts.map((post) => ({
        slug: post.filename,
    }));
};

async function TagsPage({ params }: { params: { slug: string } }) {
    const postMetadata = getPostMetadata(`${params.slug}`);
    const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);

    return (
        <>
        {posts}
        </>
    );
}

export default TagsPage;
