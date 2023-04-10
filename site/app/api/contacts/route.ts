import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
const prisma = new PrismaClient();

export async function GET(request: Request) {
    let contacts = await prisma.contacts.findMany({
        orderBy: {
            platform: "asc"
        }
    })

    return NextResponse.json(contacts)
}