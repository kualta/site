import getPostMetadata from '@/components/PostMetadata';
import PostPreview from '@/components/PostPreview';
import Link from 'next/link';

const HomePage = () => {
    const postMetadata = getPostMetadata();
    const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
    const tagList = [...new Set(postMetadata.flatMap((post) => post.tags))];
    const tags = tagList.map((tag) => {
        const slug = tag.replace(/\s+/g, '-').toLowerCase();
        return (
            <Link key={slug} href={'/tags/' + slug}>
                {tag}
            </Link>
        );
    });

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
