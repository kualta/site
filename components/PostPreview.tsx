import Image from "next/image";
import Link from "next/link";
import { PostMetadata } from "./PostMetadata";
import { Card } from "./Card";

const PostPreview = (props: PostMetadata) => {
  const published = new Date(props.date);
  const today = new Date();
  const diff = today.getTime() - published.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const newFlair = days < 30;

  return (
    <Link href={`/posts/${props.filename}`} className="w-fit sm:w-full sm:mx-16 relative">
      <Card key={props.description}>
        <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-4 w-fit">
          {newFlair && (
            <div
              className="absolute top-0 right-0 text-xs hidden sm:flex border px-2 pb-0.5 m-3
            rounded-lg text-secondary-text leading-4 -mb-1 text-text dark:text-dark-text"
            >
              new
            </div>
          )}

          <div className="grow h-36 sm:h-28 aspect-video relative">
            <Image src={props.preview} alt={props.title} fill={true} className="rounded-xl object-contain" />
          </div>

          <div className="flex flex-col gap-1 sm:gap-2 w-full">
            <h1 className="font-extrabold text-xl">{props.title}</h1>
            <p className="text-base flex-grow">{props.description}</p>
            <p className="text-sm text-secondary-text">{props.date}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
};

export default PostPreview;