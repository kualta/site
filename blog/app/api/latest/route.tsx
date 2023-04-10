import getPostMetadata from 'components/PostMetadata';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    let latestPost = getPostMetadata()[0];
    let linkablePost = {
        name: latestPost.title,
        description: latestPost.description,
        link: 'https://blog.kualta.dev/posts/' + latestPost.filename
    } 
    return NextResponse.json(linkablePost);
}
