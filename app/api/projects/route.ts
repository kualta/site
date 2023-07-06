import { PrismaClient } from "@prisma/client";
import { getAllProjects } from "../dataFetch";

export async function GET(request: Request) {
	return getAllProjects();
}
