import { PrismaClient } from "@prisma/client";
import { getAllProjects } from "../../../extra/dataFetch";

export async function GET(request: Request) {
  return getAllProjects();
}
