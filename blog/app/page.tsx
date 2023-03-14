import getPostMetadata from '@/components/getPostMetadata';
import PostPreview from '@/components/PostPreview';
import Link from 'next/link';

const HomePage = () => {
    const postMetadata = getPostMetadata();
    const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
    const tags = [...new Set(postMetadata.flatMap((post) => post.tags))].map((tag) => (
        <Link key={tag} href={'/tags/' + tag}>
            {tag}
        </Link>
    ));

    return (
        <div>
            <div className="flex place-items-center justify-center flex-row flex-wrap gap-8 p-4 border-b border-neutral-800">
                {tags}
            </div>
            {posts}
        </div>
    );
};

export default HomePage;
