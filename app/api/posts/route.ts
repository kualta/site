import { getAllPosts } from "../../../extra/dataFetch";

export async function GET() {
  return getAllPosts();
}
