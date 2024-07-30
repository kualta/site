import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const login = process.env.MAIL_LOGIN;
  const password = process.env.MAIL_PASSWORD;

  const email = request.nextUrl.searchParams.get("email");

  if (!email) {
    return NextResponse.json({
      error: "Email is required",
      message: "Email is required",
      status: 400,
    });
  }

  const formData = {
    email: email,
    name: email.split("@")[0],
    status: "enabled",
    lists: [1],
  };

  const res = await fetch("https://mail.kualta.dev/api/subscribers", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${login}:${password}`)}`,
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
