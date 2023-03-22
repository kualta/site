'use client';

import { GrayMatterFile } from 'gray-matter';
import Markdown from 'markdown-to-jsx';

export default function PostPage(params: { post: GrayMatterFile<string> }) {
    return (
        <article className="py-8 prose dark:prose-invert prose-img:rounded-xl ">
            <Markdown
            // TODO!
            // options={{
            //     overrides: {
            //         img: {
            //             component: Image,
            //             props: {
            //                 // layout: 'fill',
            //                 fill: true,
            //             },
            //         },
            //     },
            // }}
            >
                {params.post.content}
            </Markdown>
        </article>
    );
}
