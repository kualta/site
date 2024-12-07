import { FadeIn } from "@/components/Transitions";
import getPostsMetadata from "components/PostMetadata";
import PostCard from "@/components/PostCard";
import Link from "next/link";

export const generateStaticParams = async () => {
  const posts = getPostsMetadata();
  return posts.map((post) => ({
    slug: post.filename,
  }));
};

async function TagsPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const filter = params.slug;
  const postMetadata = getPostsMetadata().filter((post) => post.tags.indexOf(filter) !== -1);
  const posts = postMetadata.map((post) => <PostCard key={post.filename} {...post} />);
  const tagText = params.slug.replace("-", " ").toLowerCase();

  return (
    <div className="max-w-2xl">
      <FadeIn>
        <div className="flex flex-col place-items-center justify-center gap-4 mb-20">
          <div className="flex place-content-center justify-center flex-row flex-wrap p-4">
            <Link href="/posts/">
              <span className="select-none">•</span>
              <span className="px-4 ">{tagText}</span>
              <span className="select-none">•</span>
            </Link>
          </div>
          {posts}
        </div>
      </FadeIn>
    </div>
  );
}

export default TagsPage;
