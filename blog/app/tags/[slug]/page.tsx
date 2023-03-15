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
        <>
            <div className="flex justify-center text-center p-4">
                <Link href="/">
                    <span className="select-none">•</span>
                    <span className="p-4 text-xl ">{tagText}</span>
                    <span className="select-none">•</span>
                </Link>
            </div>
            {/* FIXME: remove empty posts from tag match */}
            {posts}
        </>
    );
}

export default TagsPage;
