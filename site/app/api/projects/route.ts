import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";

export const revalidate = 5;

const prisma = new PrismaClient();

export async function GET(request: Request) {
	const projects = await prisma.project.findMany({
		orderBy: {
			relevance: "desc",
		},
	});

	return NextResponse.json(projects);
}
