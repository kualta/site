import { getAllPosts } from "../dataFetch";

export async function GET() {
	return getAllPosts();
}
