import { getPostContent } from "@/components/PostContent";
import SubscriptionBox from "@/components/SubscriptionBox";
import { FadeIn } from "@/components/Transitions";
import getPostsMetadata from "components/PostMetadata";
import { GrayMatterFile } from "gray-matter";
import Markdown from "markdown-to-jsx";
import { Metadata } from "next";
import dynamic from "next/dynamic";

const TableOfContents = dynamic(() => import("components/TableOfContents"), {
  ssr: false,
});

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

function PostContent({ post }: { post: GrayMatterFile<string> }) {
  return (
    <article
      className={
        "z-[10] max-w-2xl rounded-xl p-2 py-8 prose dark:prose-invert dark:prose-blockquote:border-dark-primary prose-img:rounded-2xl"
      }
    >
      <h1 className="mb-2 text-center">{post.data.title}</h1>
      <h3 className="mb-6 mt-0 text-center">{post.data.description}</h3>
      <Markdown
        options={{
          overrides: {
            h1: { props: { className: "pt-6 -mt-6" } },
            h2: { props: { className: "pt-6 -mt-6" } },
            h3: { props: { className: "pt-6 -mt-6" } },
            h4: { props: { className: "pt-6 -mt-6" } },
            h5: { props: { className: "pt-6 -mt-6" } },
            h6: { props: { className: "pt-6 -mt-6" } },
          },
        }}
      >
        {post.content}
      </Markdown>
    </article>
  );
}

export default function PostPage({ params }: any) {
  const post = getPostContent(params.slug);

  return (
    <div className="max-w-2xl w-full relative mb-10">
      <FadeIn>
        <TableOfContents toc={post.toc} />
      </FadeIn>
      <PostContent post={post} />
      <SubscriptionBox />
    </div>
  );
}
