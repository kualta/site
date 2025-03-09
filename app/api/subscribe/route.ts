import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const apiUsername = process.env.LISTMONK_API_USERNAME;
  const accessToken = process.env.LISTMONK_ACCESS_TOKEN;
  const baseUrl = process.env.LISTMONK_BASE_URL || "https://mail.kualta.dev";

  const email = request.nextUrl.searchParams.get("email");
  const list = Number.parseInt(request.nextUrl.searchParams.get("list") || "4");

  if (!email) {
    return NextResponse.json({
      error: "Email is required",
      message: "Email is required",
      status: 400,
    });
  }

  const formData = {
    email,
    name: email.split("@")[0],
    status: "enabled",
    lists: [list],
    preconfirm_subscriptions: true,
  };

  const authString = Buffer.from(`${apiUsername}:${accessToken}`).toString("base64");

  try {
    const res = await fetch(`${baseUrl}/api/subscribers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${authString}`,
      },
      body: JSON.stringify(formData),
    });

    const responseData = await res.text();
    
    if (!res.ok) {
      console.error("Listmonk API error:", responseData);
      return NextResponse.json({
        error: "Subscription failed",
        message: responseData,
        status: res.status,
      });
    }

    return NextResponse.json({
      message: "Subscribed successfully",
      status: res.status,
      data: JSON.parse(responseData),
    });
  } catch (error) {
    console.error("Error connecting to Listmonk:", error);
    return NextResponse.json({
      error: "Connection error",
      message: error instanceof Error ? error.message : "Unknown error",
      status: 500,
    });
  }
}
