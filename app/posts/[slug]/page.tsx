import getPostContent from "components/PostContent";
import getPostMetadata from "components/PostMetadata";
import { GrayMatterFile } from "gray-matter";
import Markdown from "markdown-to-jsx";
import { Metadata } from "next";

export function generateMetadata({ params }: any): Metadata {
  const post = getPostContent(params.slug);
  return {
    title: post.data.title,
    description: post.data.description,
    openGraph: {
      images: [post.data.preview],
    },
  };
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
    <div className="max-w-2xl w-full">
      <PostPage post={post} />
    </div>
  );
}

function PostPage({ post }: { post: GrayMatterFile<string> }) {
  return (
    <article
      className={
        "z-[10] max-w-2xl rounded-xl  p-2 py-8 prose dark:prose-invert dark:prose-blockquote:border-dark-primary prose-img:rounded-2xl"
      }
    >
      <h1 className="mb-2 text-center">{post.data.title}</h1>
      <h3 className="mb-6 mt-0 text-center">{post.data.description}</h3>
      <Markdown>{post.content}</Markdown>
    </article>
  );
}
