import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
const prisma = new PrismaClient();

export const revalidate = 5;

export async function GET(request: Request) {
    let contacts = await prisma.contact.findMany({
        orderBy: {
            platform: "asc"
        }
    })

    return NextResponse.json(contacts)
}