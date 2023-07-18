import { PrismaClient } from "@prisma/client";
import { getAllProjects } from "../../../prisma/dataFetch";

export async function GET(request: Request) {
  return getAllProjects();
}
