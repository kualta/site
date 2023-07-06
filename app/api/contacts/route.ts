import { NextResponse } from "next/server";
import { getAllContacts } from "../dataFetch";

export async function GET(request: Request) {
	return await getAllContacts();
}
