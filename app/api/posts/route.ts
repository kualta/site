import { getAllPosts } from "@/lib/dataFetch";

export async function GET() {
  return getAllPosts();
}
