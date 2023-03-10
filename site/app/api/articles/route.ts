import { NextResponse } from "next/server";
import data from 'public/data.json';

export type Article = typeof data['articles'][0];

export async function GET(request: Request) {
    return NextResponse.json(data.articles)
}