import Image from 'next/image';
import Link from 'next/link';
import { roboto_mono } from './Fonts';
import { PostMetadata } from './PostMetadata';

const PostPreview = (props: PostMetadata) => {
    return (
        <div key={props.description} className="my-4 p-4 border-b-2 dark:border-neutral-800">
            <Link href={`/blog/${props.filename}`} className="flex flex-col md:flex-row items-center gap-4">
                <Image src={props.preview} alt={props.title} width={200} height={100} className="rounded-xl" />
                <div className="flex flex-col gap-2 p-4">
                    <p className={`font-extrabold text-xl ${roboto_mono.className}`}>{props.title}</p>
                    <p className={"flex-grow "}>{props.description}</p>
                    <p className="text-sm w-20">{props.date}</p>
                </div>
            </Link>
        </div>
    );
};

export default PostPreview;
