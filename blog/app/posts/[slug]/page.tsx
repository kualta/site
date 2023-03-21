import { roboto_mono } from '@/components/Fonts';
import getPostContent from '@/components/PostContent';
import getPostMetadata from '@/components/PostMetadata';
import Markdown from 'markdown-to-jsx';
import Link from 'next/link';

export async function generateMetadata({ params, searchParams }: any) {
    const post = getPostContent(params.slug);
    return { title: post.data.title };
}

export const generateStaticParams = async () => {
    const posts = getPostMetadata();
    return posts.map((post) => ({
        slug: post.filename,
    }));
};

export default async function PostPage({ params }: { params: { slug: string } }) {
    const post = getPostContent(params.slug);

    return (
        <article className="py-8 prose dark:prose-invert prose-img:rounded-xl xl:prose-lg">
            <Markdown>{post.content}</Markdown>
            <footer
                className={`flex flex-col underline-offset-2 border-t dark:border-neutral-800 pt-4 mt-8 place-content-between place-items-center w-full ${roboto_mono.className}`}
            >
                <div className="flex flex-row place-content-between w-full place-items-center text-sm ">
                    <Link className="no-underline hover:underline" href="/">{`< home`}</Link>
                    <div className="flex flex-row gap-4">
                        <a
                            href={'mailto:contact@kualta.dev'}
                            className="no-underline hover:underline"
                        >{`questions, thoughts, feelings to share?`}</a>
                    </div>
                    <a className="no-underline hover:underline" href="https://kualta.dev/">{`main >`}</a>
                </div>
            </footer>
        </article>
    );
}
