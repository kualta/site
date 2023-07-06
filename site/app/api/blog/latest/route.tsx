import getPostMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
	return getLatestPost();
}

export async function getLatestPost(): Promise<NextResponse> {
	const latestPost = getPostMetadata()[0];
	const linkablePost = {
		name: latestPost.title,
		description: latestPost.description,
		link: `https://kualta.dev/blog/${latestPost.filename}`,
	};
	return NextResponse.json(linkablePost);
}
