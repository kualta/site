import Image from "next/image";
import Link from "next/link";
import { PostMetadata } from "./PostMetadata";
import { Card } from "./Card";

const PostPreview = (props: PostMetadata) => {
  return (
    <Card key={props.description}>
      <div className="font-sans">
        <Link
          href={`/posts/${props.filename}`}
          className="flex flex-col md:flex-row items-center gap-4"
        >
          <Image
            src={props.preview}
            alt={props.title}
            width={200}
            height={100}
            className="rounded-xl border border-primary dark:border-dark-primary"
          />
          <div className="flex flex-col gap-2 p-4">
            <p className="font-extrabold text-xl">{props.title}</p>
            <p className="flex-grow">{props.description}</p>
            <p className="text-sm text-secondary-text">{props.date}</p>
          </div>
        </Link>
      </div>
    </Card>
  );
};

export default PostPreview;
