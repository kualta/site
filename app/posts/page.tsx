import getPostsMetadata from "components/PostMetadata";
import PostCard from "@/components/PostCard";
import { SubscriptionBox } from "@/components/SubscriptionBox";

export const metadata = {
  title: "posts",
  description: "kualta's blog posts",
};

const HomePage = async () => {
  const postMetadata = await getPostsMetadata();
  const posts = postMetadata.map((post) => <PostCard key={post.filename} {...post} />);

  return (
    <div className="max-w-xl w-full grow flex flex-col mb-10">
      <div className="flex flex-col gap-2 p-4">
        {posts}
      </div>
      <div className="mt-auto pt-8 pb-0">
        <SubscriptionBox />
      </div>
    </div>
  );
};

export default HomePage;
