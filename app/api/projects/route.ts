import { NextResponse } from "next/server";

export async function GET(request: Request) {
    let projects = [
        'hemi',
        'pomo',
        'mine',
    ];
    return NextResponse.json({ projects })
}