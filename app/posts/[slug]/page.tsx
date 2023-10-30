import getPostContent from "components/PostContent";
import getPostMetadata from "components/PostMetadata";
import { GrayMatterFile } from "gray-matter";
import Markdown from "markdown-to-jsx";
import { fredoka } from "styles/fonts";

export function generateMetadata({ params }: any) {
  const post = getPostContent(params.slug);
  return { title: post.data.title };
}

export const generateStaticParams = async () => {
  const posts = getPostMetadata();
  return posts.map((post) => ({
    slug: post.filename,
  }));
};

export default function Page({ params }: any) {
  const post = getPostContent(params.slug);

  return (
    <div className="max-w-2xl">
      <PostPage post={post} />
    </div>
  );
}

function PostPage({ post }: { post: GrayMatterFile<string> }) {
  return (
    <article
      className={
        "z-[10] backdrop-blur-sm py-8 prose dark:prose-invert dark:prose-blockquote:border-dark-primary prose-img:rounded-2xl"
      }
    >
      <Markdown>{post.content}</Markdown>
    </article>
  );
}
