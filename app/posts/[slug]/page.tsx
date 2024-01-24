import { getPostContent } from "@/components/PostContent";
import getPostsMetadata from "components/PostMetadata";
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
    twitter: {
      images: [post.data.preview],
      card: "summary_large_image",
      title: post.data.title,
      description: post.data.description,
    },
    authors: [
      {
        name: "kualta",
      },
    ],
  };
}

export const generateStaticParams = async () => {
  const posts = getPostsMetadata();
  return posts.map((post) => ({
    slug: post.filename,
  }));
};

function TableOfContents({ toc }: { toc: any }) {
  return (
    <div className="top-8 left-[70%] fixed hidden 2xl:flex">
      <Markdown options={{ overrides: { h2: { props: { className: "text-lg" } } } }}>{toc}</Markdown>
    </div>
  );
}

function PostContent({ post }: { post: GrayMatterFile<string> }) {
  return (
    <article
      className={
        "z-[10] max-w-2xl rounded-xl p-2 py-8 prose dark:prose-invert dark:prose-blockquote:border-dark-primary prose-img:rounded-2xl"
      }
    >
      <h1 className="mb-2 text-center">{post.data.title}</h1>
      <h3 className="mb-6 mt-0 text-center">{post.data.description}</h3>
      <Markdown>{post.content}</Markdown>
    </article>
  );
}

export default function PostPage({ params }: any) {
  const post = getPostContent(params.slug);

  return (
    <div className="max-w-2xl w-full relative">
      {/* <TableOfContents toc={post.toc} /> */}
      <PostContent post={post} />
    </div>
  );
}
