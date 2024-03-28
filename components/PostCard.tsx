import Image from "next/image";
import Link from "next/link";
import { PostMetadata } from "./PostMetadata";
import { Card } from "./Card";

const PostCard = (props: PostMetadata) => {
  const published = new Date(props.date);
  const today = new Date();
  const diff = today.getTime() - published.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  const tags = props.tags.map((tag) => (
    <span
      className="text-xs text-secondary-text mr-1 p-1 py-0.5 border secondary-border leading-3 rounded-lg"
      key={tag}
    >
      {tag.replace("-", " ")}
    </span>
  ));

  if (days < 30)
    tags.push(
      <span
        className="text-xs text-accent dark:text-dark-accent mr-1 p-1 py-0.5 border secondary-border leading-3 rounded-lg"
        key={"newtag"}
      >
        new
      </span>,
    );

  return (
    <Link href={`/posts/${props.filename}`} className="sm:w-[640px] min-w-[250px] w-fit relative">
      <Card key={props.description}>
        <div className="flex flex-col sm:flex-row items-center gap-6 sm:gap-4 w-fit">
          <div className="grow min-w-[230px] w-[80vw] sm:w-[300px] aspect-video relative">
            <Image
              src={props.preview}
              alt={props.title}
              fill={true}
              className="rounded-xl object-contain"
              priority={true}
            />
          </div>

          <div className="flex flex-col gap-1 sm:gap-2 w-full">
            <h1 className="font-extrabold text-xl">{props.title}</h1>
            <p className="text-base flex-grow max-w-sm">{props.description}</p>
            <div className="flex flex-row">{tags}</div>
            <p className="text-sm text-secondary-text">{props.date}</p>
          </div>
        </div>
      </Card>
    </Link>
  );
};

export default PostCard;
