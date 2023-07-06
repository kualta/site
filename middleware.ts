import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function middleware(request: NextRequest) {
	const hostname = request.headers.get("host") ?? "";
	const { pathname } = request.nextUrl;

	if (hostname.startsWith("vids")) {
		return NextResponse.redirect("https://kualta.dev/vids");
	}
	if (hostname.startsWith("arts")) {
		return NextResponse.redirect("https://kualta.dev/arts");
	}
	if (hostname.startsWith("noir")) {
		return NextResponse.redirect("https://kualta.dev/noir");
	}
	if (hostname.startsWith("git")) {
		return NextResponse.redirect("https://kualta.dev/git");
	}
	if (hostname.startsWith("bbdd")) {
		return NextResponse.redirect("https://kualta.dev/blackbox");
	}
	if (hostname.startsWith("moji")) {
		return NextResponse.redirect("https://kualta.dev/kumoji");
	}
	if (hostname.startsWith("blog")) {
		return NextResponse.redirect("https://kualta.dev/blog");
	}
	if (pathname.startsWith("/_next")) return NextResponse.next();
}
