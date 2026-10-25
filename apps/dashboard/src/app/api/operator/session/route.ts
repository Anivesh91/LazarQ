import { NextRequest, NextResponse } from "next/server";
import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_MAX_AGE,
  isValidOperatorPassword,
} from "../../../../lib/operator-session";

export async function POST(request: NextRequest) {
  if (
    !process.env.DASHBOARD_OPERATOR_PASSWORD ||
    !process.env.DASHBOARD_SESSION_SECRET ||
    process.env.DASHBOARD_SESSION_SECRET.length < 32
  ) {
    return NextResponse.json(
      { message: "Dashboard operator authentication is not configured" },
      { status: 503 }
    );
  }

  let password: unknown;
  try {
    password = (await request.json()).password;
  } catch {
    return NextResponse.json({ message: "Invalid request body" }, { status: 400 });
  }
  if (typeof password !== "string" || !isValidOperatorPassword(password)) {
    return NextResponse.json(
      { message: "Invalid operator credentials" },
      { status: 401 }
    );
  }

  const session = createOperatorSession();
  if (!session) {
    return NextResponse.json(
      { message: "Dashboard operator authentication is not configured" },
      { status: 503 }
    );
  }

  const response = NextResponse.json({ success: true });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OPERATOR_SESSION_COOKIE, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: OPERATOR_SESSION_MAX_AGE,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ success: true });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OPERATOR_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
