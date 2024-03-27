import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const redirects: { [key: string]: string } = {
  vids: "https://kualta.dev/vids",
  arts: "https://kualta.dev/arts",
  git: "https://kualta.dev/git/kualta",
  api: "https://kualta.dev/api",
  repo: "https://kualta.dev/git/kualta",
  moji: "https://kualta.dev/kaomoji",
  blog: "https://kualta.dev/posts",
  post: "https://kualta.dev/posts",
  pics: "https://kualta.dev/pics",
  join: "https://kualta.dev/join",
  road: "https://kualta.dev/roadmap",
};

export function middleware(request: NextRequest) {
  const hostname = request.headers.get("host") ?? "";
  const { pathname } = request.nextUrl;

  for (const key in redirects) {
    if (hostname.startsWith(key)) {
      return NextResponse.redirect(redirects[key]);
    }
  }
  if (pathname.startsWith("/_next")) return NextResponse.next();
}
