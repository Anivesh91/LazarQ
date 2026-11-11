import { NextRequest, NextResponse } from "next/server";
import {
  getOperatorAuthState,
  OPERATOR_SESSION_COOKIE,
  verifyOperatorSessionToken,
} from "./lib/operator-session-edge";

export async function middleware(request: NextRequest) {
  const authState = getOperatorAuthState();
  if (!authState.authRequired) {
    return NextResponse.next();
  }

  const { pathname, search } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const token = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  const authorized = await verifyOperatorSessionToken(token);

  if (pathname === "/login") {
    if (authorized) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  if (!authorized) {
    const loginUrl = new URL("/login", request.url);
    const nextPath = `${pathname}${search}`;
    if (nextPath && nextPath !== "/") {
      loginUrl.searchParams.set("next", nextPath);
    }
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
