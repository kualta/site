import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const login = process.env.MAIL_LOGIN;
  const password = process.env.MAIL_PASSWORD;

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
  };

  const authString = Buffer.from(`${login}:${password}`).toString("base64");

  const res = await fetch("https://mail.kualta.dev/api/subscribers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${authString}`,
    },
    body: JSON.stringify(formData),
  });

  if (!res.ok) {
    return NextResponse.json({
      error: "Something went wrong",
      message: await res.text(),
      status: res.status,
    });
  }

  return NextResponse.json({
    message: "Subscribed successfully",
    status: res.status,
  });
}
