import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const redirects: { [key: string]: string } = {
  vids: "https://kualta.dev/vids",
  arts: "https://kualta.dev/arts",
  noir: "https://kualta.dev/noir",
  git: "https://kualta.dev/repo/kualta",
  api: "https://kualta.dev/api",
  apis: "https://kualta.dev/api",
  repo: "https://kualta.dev/repo/kualta",
  bbdd: "https://kualta.dev/blackbox",
  moji: "https://kualta.dev/kaomoji",
  blog: "https://kualta.dev/blog",
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
