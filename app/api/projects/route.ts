import { getAllProjects } from "@/lib/dataFetch";

export async function GET(request: Request) {
  return getAllProjects();
}
