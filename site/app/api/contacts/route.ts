import { PrismaClient } from "@prisma/client";
import { NextResponse } from "next/server";
const prisma = new PrismaClient();

export async function GET() {
	return getAllContacts();
}

export async function getAllContacts() {
	const contacts = await prisma.contact.findMany({
		orderBy: {
			platform: "asc",
		},
	});

	return NextResponse.json(contacts);
}
