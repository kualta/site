import { NextResponse } from "next/server";
import data from 'public/data.json';

export type Project = typeof data['projects'][0];

export async function GET(request: Request) {
    let projects = data.projects.sort((a, b) => {
        let first = Date.parse(a.date)
        let second = Date.parse(b.date)
        return second - first
    })
    return NextResponse.json(projects)
}