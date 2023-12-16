import { FadeIn } from "@/components/Transitions";
import getPostMetadata from "components/PostMetadata";
import PostPreview from "components/PostPreview";
import Link from "next/link";

export const generateStaticParams = async () => {
  const posts = getPostMetadata();
  return posts.map((post) => ({
    slug: post.filename,
  }));
};

async function TagsPage({ params }: { params: { slug: string } }) {
  const filter = params.slug;
  const postMetadata = getPostMetadata().filter((post) => post.tags.indexOf(filter) !== -1);
  const posts = postMetadata.map((post) => <PostPreview key={post.filename} {...post} />);
  const tagText = params.slug.replace("-", " ").toLowerCase();

  return (
    <FadeIn>
      <div className="flex flex-col place-items-center justify-center max-w-xl sm:max-w-2xl px-2 gap-4 mb-20">
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
  );
}

export default TagsPage;
