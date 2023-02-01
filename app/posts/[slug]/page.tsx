import { readFileSync } from "fs"
import matter from "gray-matter";
import Markdown from "markdown-to-jsx";

const getPostContent = (slug: string) => {
    const folder = 'posts/';
    const file = `${folder}${slug}.md`;
    const content = readFileSync(file, 'utf-8');
    const post = matter(content);

    return post;
}

const PostPage = (props: any) => {
    const slug = props.params.slug;
    const post = getPostContent(slug);
    console.log(post)

    return (
        <>
            <h1>{post.data.title}</h1>
            <Markdown>{post.content}</Markdown>
        </>
    )
}

export default PostPage