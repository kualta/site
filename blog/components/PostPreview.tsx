import Link from 'next/link';
import { roboto_mono } from './Fonts';
import { PostMetadata } from './PostMetadata';

const PostPreview = (props: PostMetadata) => {
    return (
        <div key={props.description} className="my-4 p-4 border-b-2 dark:border-neutral-800">
            <Link href={`/posts/${props.filename}`} className="flex flex-row items-center space-x-4">
                <p className={`font-bold ${roboto_mono.className}`}>{props.title}</p>
                <p className={`flex-grow `}>{props.description}</p>
                <p className="text-sm w-20">{props.date}</p>
            </Link>
        </div>
    );
};

export default PostPreview;
