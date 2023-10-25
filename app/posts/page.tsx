import { FadeIn } from "@/components/Transitions";
import getPostMetadata from "components/PostMetadata";
import PostPreview from "components/PostPreview";
import Link from "next/link";

const HomePage = () => {
  const postMetadata = getPostMetadata();
  const posts = postMetadata.map((post) => (
    <PostPreview key={post.filename} {...post} />
  ));
  const tagsSet = [...new Set(postMetadata.flatMap((post) => post.tags))];
  const tags = tagsSet.map((tag, i, arr) => {
    const text = tag.replace("-", " ").toLowerCase();

    const divider =
      i !== arr.length - 1 ? (
        <span className="select-none px-4">•</span>
      ) : (
        <></>
      );

    return (
      <div key={tag}>
        <Link href={`/posts/tags/${tag}`} className="hover:scale-110">
          {text}
        </Link>
        {divider}
      </div>
    );
  });

  return (
    <FadeIn>
      <div className="flex flex-col place-items-center justify-center max-w-xl sm:max-w-2xl px-2 gap-4 mb-20">
        <div className="flex place-content-center justify-center flex-row flex-wrap p-4">
          {tags}
        </div>
        {posts}
      </div>
    </FadeIn>
  );
};

export default HomePage;
