import { getAllPosts } from "../../../prisma/dataFetch";

export async function GET() {
  return getAllPosts();
}
