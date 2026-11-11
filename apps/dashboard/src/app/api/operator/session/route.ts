import { NextRequest, NextResponse } from "next/server";
import {
  createOperatorSession,
  getOperatorAuthState,
  isAuthorizedOperatorSession,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_MAX_AGE,
  isValidOperatorPassword,
} from "../../../../lib/operator-session";

function shouldUseSecureSessionCookie(): boolean {
  if (process.env.DASHBOARD_COOKIE_SECURE === "false") {
    return false;
  }
  if (process.env.DASHBOARD_COOKIE_SECURE === "true") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

export async function GET(request: NextRequest) {
  const authState = getOperatorAuthState();
  const response = NextResponse.json({
    authEnabled: authState.authRequired,
    configured: authState.configured,
    misconfigured: authState.misconfigured,
    authenticated: isAuthorizedOperatorSession(request),
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function POST(request: NextRequest) {
  const authState = getOperatorAuthState();
  if (!authState.configured) {
    return NextResponse.json(
      {
        message:
          authState.reason || "Dashboard operator authentication is not configured",
      },
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

  const secureCookie = shouldUseSecureSessionCookie();
  const response = NextResponse.json({ success: true });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OPERATOR_SESSION_COOKIE, session, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict",
    path: "/",
    maxAge: OPERATOR_SESSION_MAX_AGE,
  });
  return response;
}

export async function DELETE() {
  const secureCookie = shouldUseSecureSessionCookie();
  const response = NextResponse.json({ success: true });
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set(OPERATOR_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return response;
}
