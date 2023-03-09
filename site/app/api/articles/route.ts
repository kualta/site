import { NextResponse } from "next/server";
import data from 'public/data.json';


export async function GET(request: Request) {
    return NextResponse.json(data.articles)
}