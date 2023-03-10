import { NextResponse } from "next/server";
import data from 'public/data.json';

export type Project = typeof data['projects'][0];

export async function GET(request: Request) {
    return NextResponse.json(data.projects)
}