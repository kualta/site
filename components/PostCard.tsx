import Link from "next/link";
import type { PostMetadata } from "./PostMetadata";

const PostCard = (props: PostMetadata) => {
  return (
    <Link href={`/posts/${props.filename}`} className="w-full flex flex-row items-baseline gap-2 hover:opacity-70 text-lg">
      <span className="font-medium">{props.title}</span>
      <span className="flex-grow border-b border-dotted border-secondary-text opacity-50" />
      <span className="text-sm text-secondary-text whitespace-nowrap font-mono">{props.date}</span>
    </Link>
  );
};

export default PostCard;
