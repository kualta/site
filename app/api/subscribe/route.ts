import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email");

  if (!email) {
    return NextResponse.json({
      error: "Email is required",
      status: 400,
    });
  }

  try {
    const res = await fetch("https://api.paragraph.com/api/v1/subscribers", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.PARAGRAPH_API_KEY}`,
      },
      body: JSON.stringify({ email }),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error("Paragraph API error:", data);
      return NextResponse.json({
        error: "Subscription failed",
        status: res.status,
      });
    }

    return NextResponse.json({
      message: "Subscribed successfully",
      status: 200,
    });
  } catch (error) {
    console.error("Error subscribing:", error);
    return NextResponse.json({
      error: "Connection error",
      status: 500,
    });
  }
}
