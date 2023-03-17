import getPostMetadata from '@/components/PostMetadata';
import PostPreview from '@/components/PostPreview';
import Link from 'next/link';

export const generateStaticParams = async () => {
    const posts = getPostMetadata();
    return posts.map((post) => ({
        slug: post.filename,
    }));
};

async function TagsPage({ params }: { params: { slug: string } }) {
    const postMetadata = getPostMetadata(`${params.slug}`);
    const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
    const tagText = params.slug.replace('-', ' ').toLowerCase();

    return (
        <div>
            <div className="flex place-items-center justify-center flex-row flex-wrap gap-x-8 p-4 mb-10">
                <Link href="/">
                    <span className="select-none">•</span>
                    <span className="px-4 ">{tagText}</span>
                    <span className="select-none">•</span>
                </Link>
            </div>
            {posts}
        </div>
    );
}

export default TagsPage;
