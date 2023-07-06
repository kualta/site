import getPostMetadata from "components/PostMetadata";
import { NextResponse } from "next/server";

export async function GET() {
    return getAllPosts()
}

export async function getAllPosts() {
	const posts = getPostMetadata();
	const linkablePosts = posts.map((post) => ({
		name: post.title,
		description: post.description,
		link: `https://kualta.dev/blog/${post.filename}`,
	}));
	return NextResponse.json(linkablePosts);
}
