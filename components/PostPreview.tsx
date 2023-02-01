import Link from "next/link";
import PostMetadata from "./PostMetadata";

const PostPreview = (props: PostMetadata) => {
    return (
        <div className="my-4 py-4 px-4 shadow-sm rounded-xl dark:shadow-slate-200/10">
            <p className="text-sm">{props.date}</p>
            <Link href={`/posts/${props.slug}`} className="flex flex-row space-x-4">
                <b>{props.title}</b>
                <p>{props.description}</p>
            </Link>
        </div>
    );
}

export default PostPreview;