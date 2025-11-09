import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const redirects: { [key: string]: string } = {
  moji: "https://kualta.dev/kaomoji",
  blog: "https://kualta.dev/posts",
  post: "https://kualta.dev/posts",
  join: "https://kualta.dev/join",
};

export function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") ?? "";
  const { pathname, searchParams } = request.nextUrl;

  for (const key in redirects) {
    if (hostname.startsWith(key)) {
      return NextResponse.redirect(redirects[key]);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
