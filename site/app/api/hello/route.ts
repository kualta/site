import { NextResponse } from "next/server";

export const revalidate = 5;

export async function GET(request: Request) {
  let phrases = [
    'hi',
    'hello',
    'ayo what\'s up',
  ];
  let phrase = phrases[Math.floor(Math.random() * phrases.length)];
  return NextResponse.json({ message: `kualta says: ${phrase}` })
}
