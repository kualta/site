import getPostMetadata from 'components/PostMetadata';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    let posts = getPostMetadata();
    let linkablePosts = posts.map((post) => ({
        name: post.title,
        description: post.description,
        link: 'https://blog.kualta.dev/posts/' + post.filename,
    }));
    return NextResponse.json(linkablePosts);
}
