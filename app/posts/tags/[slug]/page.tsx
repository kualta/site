import { FadeIn } from "@/components/Transitions";
import getPostsMetadata from "components/PostMetadata";
import PostPreview from "components/PostPreview";
import Link from "next/link";

export const generateStaticParams = async () => {
  const posts = getPostsMetadata();
  return posts.map((post) => ({
    slug: post.filename,
  }));
};

async function TagsPage({ params }: { params: { slug: string } }) {
  const filter = params.slug;
  const postMetadata = getPostsMetadata().filter((post) => post.tags.indexOf(filter) !== -1);
  const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
  const tagText = params.slug.replace("-", " ").toLowerCase();

  return (
    <div className="max-w-xl sm:max-w-2xl">
      <FadeIn>
        <div className="flex flex-col place-items-center justify-center px-2 gap-4 mb-20">
          <div className="flex place-items-center justify-center flex-row flex-wrap gap-x-8 p-4">
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
