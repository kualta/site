import { roboto_mono } from '@/../components/Fonts';
import ContactIcons from '@/components/ContactIcons';
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
    const contacts = await (await fetch('https://kualta.dev/api/contacts')).json();

    return (
        <article className="py-8 prose dark:prose-invert prose-img:rounded-xl xl:prose-lg">
            <Markdown>{post.content}</Markdown>
            <footer
                className={`flex flex-row underline-offset-2 border-t dark:border-neutral-800 pt-4 mt-8 place-content-between place-items-center w-full ${roboto_mono.className}`}
            >
                <Link className="no-underline hover:underline" href="/">{`< blog`}</Link>
                <div className="flex flex-row justify-center gap-8">
                    <ContactIcons contacts={contacts} />
                </div>
                <a className="no-underline hover:underline" href="https://kualta.dev/">{`site >`}</a>
            </footer>
        </article>
    );
}
