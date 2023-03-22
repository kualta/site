import { GrayMatterFile } from 'gray-matter';
import Markdown from 'markdown-to-jsx';

export default function PostPage({ post }: { post: GrayMatterFile<string> }) {
    return (
        <article className="py-8 prose dark:prose-invert prose-img:rounded-xl ">
            <Markdown>{post.content}</Markdown>
        </article>
    );
}
