import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";

const prisma = new PrismaClient();

export async function GET(request: Request) {
    let projects = await prisma.projects.findMany({orderBy: {
        date: 'desc'
    }})

    return NextResponse.json(projects)
}