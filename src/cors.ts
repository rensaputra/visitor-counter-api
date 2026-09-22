/**
 * CORS module for the Visitor Counter API.
 *
 * Pure logic (no I/O): resolves the Allow_Origin from the environment and
 * produces the CORS header set applied to every response the Handler returns.
 * Keeping these concerns here guarantees, by construction, that no response
 * path can omit CORS headers (Requirement 6.4).
 *
 * OPTIONS Preflight_Requests are owned by the API Gateway HTTP API and answered
 * at the edge using its gateway-managed CORS configuration; they never reach the
 * Handler, so this module no longer builds preflight responses (Requirement 6.3).
 */

/** Default Allow_Origin used when `ALLOW_ORIGIN` is unset or empty (Req 6.2). */
const DEFAULT_ALLOW_ORIGIN = "*";

/** Allowed methods advertised on the Handler's CORS responses. */
const ALLOWED_METHODS = "GET, POST, OPTIONS";

/** Allowed request headers advertised on the Handler's CORS responses. */
const ALLOWED_HEADERS = "Content-Type";

/**
 * Resolve the Allow_Origin for CORS headers.
 *
 * Returns the `ALLOW_ORIGIN` environment value when it is a non-empty string
 * (Req 6.1), otherwise `*` when it is unset or empty (Req 6.2).
 */
export function resolveAllowOrigin(
  env: Record<string, string | undefined>
): string {
  const configured = env.ALLOW_ORIGIN;
  if (typeof configured === "string" && configured.length > 0) {
    return configured;
  }
  return DEFAULT_ALLOW_ORIGIN;
}

/**
 * Build the CORS header set attached to EVERY response (Req 6.4).
 *
 * The `Access-Control-Allow-Origin` value is the resolved Allow_Origin.
 */
export function corsHeaders(allowOrigin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
  };
}
