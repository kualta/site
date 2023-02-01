import Link from "next/link";
import PostMetadata from "./PostMetadata";

const PostPreview = (props: PostMetadata) => {
    return (
        <>
            <Link href={`/posts/${props.slug}`}>
                <h2>{props.title}</h2>
            </Link>
            <p>{props.description}</p>
            <p>{props.date}</p>
        </>
    );
}

export default PostPreview;