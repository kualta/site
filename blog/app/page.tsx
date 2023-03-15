import getPostMetadata from '@/components/PostMetadata';
import PostPreview from '@/components/PostPreview';
import Link from 'next/link';

const HomePage = () => {
    const postMetadata = getPostMetadata();
    const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
    const tagsSet = [...new Set(postMetadata.flatMap((post) => post.tags))];
    const tags = tagsSet
        .map((tag) => {
            const text = tag.replace('-', ' ').toLowerCase();
            return (
                <Link key={tag} href={'/tags/' + tag} className="hover:scale-110">
                    {text}
                </Link>
            );
        })
        .map((tag, i, arr) => {
            const divider = i != arr.length - 1 ? `•` : ` `;
            return (
                <>
                    {tag}
                    <span className="select-none">{divider}</span>
                </>
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
