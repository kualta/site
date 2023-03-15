import getPostMetadata from '@/components/getPostMetadata';

export const generateStaticParams = async () => {
    const posts = getPostMetadata();
    return posts.map((post) => ({
        slug: post.filename,
    }));
};

async function TagsPage({ params }: { params: { slug: string } }) {
    return <>aaa</>;
}

export default TagsPage;
