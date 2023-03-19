import getPostMetadata from '@/../components/PostMetadata';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    let posts = getPostMetadata().sort((a, b) => {
        let first = Date.parse(a.date);
        let second = Date.parse(b.date);
        return second - first;
    });
    return NextResponse.json(posts[0]);
}
