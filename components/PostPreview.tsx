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
          className="flex flex-row items-center gap-4 w-fit"
        >
          <Image
            src={props.preview}
            alt={props.title}
            width={200}
            height={100}
            className="rounded-xl border border-primary dark:border-dark-primary"
          />
          <div className="flex flex-col gap-1 sm:gap-2 p-1 sm:p-4">
            <p className="font-extrabold text-base sm:text-xl">{props.title}</p>
            <p className="text-base flex-grow">{props.description}</p>
            <p className="text-xs sm:text-sm text-secondary-text">
              {props.date}
            </p>
          </div>
        </Link>
      </div>
    </Card>
  );
};

export default PostPreview;
