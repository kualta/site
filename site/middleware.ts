import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
    const hostname = request.headers.get('host') ?? ""
    const { pathname } = request.nextUrl;
    const url = request.nextUrl

    if (hostname.startsWith('vids')) {
        url.hostname = 'kualta.dev'
        url.pathname = '/vids' + url.pathname
        NextResponse.redirect(url)
    }
    if (pathname.startsWith('/blog')) {
        url.hostname = 'blog.kualta.dev'
        NextResponse.redirect(url)
    }
    if (pathname.startsWith("/_next")) return NextResponse.next();
}
