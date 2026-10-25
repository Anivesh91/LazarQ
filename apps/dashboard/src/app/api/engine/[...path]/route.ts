import { NextRequest, NextResponse } from "next/server";
import { isAuthorizedOperatorSession } from "../../../../lib/operator-session";

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function isAllowedEngineRequest(path: string[], method: string): boolean {
  const key = path.join("/");
  const isId = (value: string | undefined) =>
    Boolean(value && value.length > 0 && !value.includes("/") && !value.includes(".."));

  const allowedMethods: Record<string, string[]> = {
    health: ["GET"],
    events: ["GET"],
    incidents: ["GET"],
    runbooks: ["GET", "POST"],
    metrics: ["GET"],
    "circuit-breaker": ["GET"],
  };

  if (
    Object.prototype.hasOwnProperty.call(allowedMethods, key) &&
    allowedMethods[key].includes(method)
  ) {
    return true;
  }
  if (path[0] === "incidents" && path.length === 2 && isId(path[1])) {
    return method === "GET";
  }
  if (
    path[0] === "incidents" &&
    path.length === 3 &&
    isId(path[1])
  ) {
    return (
      (path[2] === "recoveries" && method === "GET") ||
      (["approve", "reject"].includes(path[2]) && method === "POST")
    );
  }
  return (
    path[0] === "runbooks" &&
    path.length === 2 &&
    isId(path[1]) &&
    method === "DELETE"
  );
}

async function proxyEngineRequest(
  request: NextRequest,
  { params }: RouteContext
): Promise<Response> {
  if (!isAuthorizedOperatorSession(request)) {
    const response = NextResponse.json(
      { message: "An authorized operator session is required" },
      { status: 401 }
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const apiKey = process.env.ENGINE_API_KEY;

  const { path } = await params;
  if (!isAllowedEngineRequest(path, request.method)) {
    const response = NextResponse.json(
      { message: "Engine endpoint or method is not available through the dashboard" },
      { status: 404 }
    );
    response.headers.set("Cache-Control", "no-store");
    return response;
  }

  const engineUrl =
    process.env.ENGINE_URL ||
    process.env.NEXT_PUBLIC_ENGINE_URL ||
    "http://localhost:5000";
  const encodedPath = path.map((segment) => encodeURIComponent(segment)).join("/");
  const enginePath =
    path[0] === "health" ? encodedPath : `api/${encodedPath}`;
  const url = new URL(
    `/${enginePath}${request.nextUrl.search}`,
    engineUrl
  );
  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (apiKey) headers.set("x-api-key", apiKey);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
      cache: "no-store",
      signal: request.signal,
    });
  } catch (error) {
    console.error("Engine proxy request failed:", error);
    return NextResponse.json(
      { message: "Unable to reach the Engine service" },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  for (const header of [
    "content-type",
    "x-accel-buffering",
    "retry-after",
  ]) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  responseHeaders.set("Cache-Control", "no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export const GET = proxyEngineRequest;
export const POST = proxyEngineRequest;
export const DELETE = proxyEngineRequest;
