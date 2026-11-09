export function isAllowedEngineRequest(path: string[], method: string): boolean {
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

  if (path[0] === "incidents" && path.length === 3 && isId(path[1])) {
    return (
      (["recoveries", "history"].includes(path[2]) && method === "GET") ||
      (["approve", "reject"].includes(path[2]) && method === "POST")
    );
  }

  return (
    path[0] === "runbooks" &&
    path.length === 2 &&
    isId(path[1]) &&
    ["GET", "PATCH", "DELETE"].includes(method)
  );
}
