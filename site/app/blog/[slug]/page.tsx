import getPostContent from "components/PostContent";
import getPostMetadata from "components/PostMetadata";
import Footer from "components/Footer";
import { GrayMatterFile } from "gray-matter";
import Markdown from "markdown-to-jsx";

export    function generateMetadata({ params }: any) {
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
		<>
			<PostPage post={post} />
			<Footer />
		</>
	);
}

function PostPage({ post }: { post: GrayMatterFile<string> }) {
	return (
		<article className="py-8 prose dark:prose-invert prose-img:rounded-2xl ">
			<Markdown>{post.content}</Markdown>
		</article>
	);
}
