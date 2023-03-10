import { NextResponse } from "next/server";
import data from 'public/data.json';

export type Contact = typeof data['contacts'][0];

export async function GET(request: Request) {
    return NextResponse.json(data.contacts)
}