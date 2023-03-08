import getPostMetadata from "@/components/getPostMetadata";
import PostPreview from "@/components/PostPreview";

const HomePage = () => {
    const postMetadata = getPostMetadata();
    const posts = postMetadata.map((post) => (
        <PostPreview key={post.slug} {...post} />
    ));

    return (
        <div>
            <div className="flex place-items-center justify-center flex-row flex-wrap gap-8 p-4 border-b border-neutral-800">
                <a href="/">Philosophy</a>
                <a href="/">Game Design</a>
                <a href="/">Tech</a>
            </div>
            {posts}
        </div>
    );
}

export default HomePage