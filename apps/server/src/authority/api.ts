export type AuthContext = { principalId: string; sessionId: string; expiresAt: string; origin: string };
export type ApiResponse = { status: number; body: { code: string; message: string } };
const mutation = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export function handleAuthorityApi(method: string, path: string, context: AuthContext | undefined, requestOrigin: string, body: unknown = {}): ApiResponse {
  if (!context || Date.parse(context.expiresAt) <= Date.now()) return { status: 401, body: { code: "authentication_required", message: "authentication required" } };
  if (context.origin !== requestOrigin) return { status: 403, body: { code: "origin_rejected", message: "origin rejected" } };
  if (mutation.has(method) && (!body || typeof body !== "object")) return { status: 422, body: { code: "invalid_request", message: "invalid request" } };
  if (!path.startsWith("/api/authority/v1/")) return { status: 404, body: { code: "not_found", message: "not found" } };
  if (path.includes("/dispatch") || path === "/api/authority/v1/grants") return { status: method === "GET" ? 200 : 405, body: { code: method === "GET" ? "ok" : "method_not_allowed", message: method === "GET" ? "ok" : "method not allowed" } };
  if (method === "GET") return { status: 200, body: { code: "ok", message: "ok" } };
  return { status: 202, body: { code: "accepted", message: `request accepted for ${context.principalId}` } };
}
