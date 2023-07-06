import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";

const prisma = new PrismaClient();

export async function GET(request: Request) {
	return getAllProjects();
}

export async function getAllProjects() {
	const projects = await prisma.project.findMany({
		orderBy: {
			relevance: "desc",
		},
	});

	return NextResponse.json(projects);
}
