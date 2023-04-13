import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";

export const revalidate = 5;

const prisma = new PrismaClient();

export async function GET(request: Request) {
    let projects = await prisma.project.findMany({
        orderBy: {
            date: 'desc'
        }
    })

    return NextResponse.json(projects)
}