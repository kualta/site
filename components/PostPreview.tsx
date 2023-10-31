import Image from "next/image";
import Link from "next/link";
import { PostMetadata } from "./PostMetadata";
import { Card } from "./Card";

const PostPreview = (props: PostMetadata) => {
  return (
    <div className="w-fit sm:w-full">
      <Card key={props.description}>
        <Link href={`/posts/${props.filename}`} className="w-full">
          <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-4 w-fit">
            <div className="grow h-36 sm:h-28 aspect-video relative">
              <Image src={props.preview} alt={props.title} fill={true} className="rounded-xl object-contain" />
            </div>
            <div className="flex flex-col gap-1 sm:gap-2 w-full">
              <h1 className="font-extrabold text-xl">{props.title}</h1>
              <p className="text-base flex-grow">{props.description}</p>
              <p className="text-sm text-secondary-text">{props.date}</p>
            </div>
          </div>
        </Link>
      </Card>
    </div>
  );
};

export default PostPreview;
