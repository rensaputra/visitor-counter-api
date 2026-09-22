/**
 * Response module for the Visitor Counter API.
 *
 * Pure logic (no I/O): serializes JSON bodies and merges the CORS header set
 * into every response. Because both builders route through `corsHeaders`, no
 * response path constructed here can omit the CORS allowed-origin header
 * (Requirement 6.4).
 */

import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { corsHeaders } from "./cors";
import type { CounterResponseBody, ErrorResponseBody } from "./types";

// `CounterResponseBody` documents the expected success-path `body` shape passed
// to `buildJsonResponse`; kept as a re-export so the type contract is explicit.
export type { CounterResponseBody };

/** Content type set on every response body produced by this module. */
const CONTENT_TYPE_JSON = "application/json";

/**
 * Build a JSON response for a given status code and body.
 *
 * Merges `corsHeaders(allowOrigin)` (Req 6.4) with `Content-Type:
 * application/json` and serializes `body` as JSON. Used for successful read
 * and increment results, where `body` is a `CounterResponseBody`.
 */
export function buildJsonResponse(
  statusCode: number,
  body: unknown,
  allowOrigin: string
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      ...corsHeaders(allowOrigin),
      "Content-Type": CONTENT_TYPE_JSON,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Build a JSON error response for a given status code and message.
 *
 * Produces an `ErrorResponseBody` (`{ error: message }`) and delegates to
 * `buildJsonResponse`, so error responses also carry the CORS headers and the
 * JSON content type (Req 6.4).
 */
export function buildErrorResponse(
  statusCode: number,
  message: string,
  allowOrigin: string
): APIGatewayProxyStructuredResultV2 {
  const body: ErrorResponseBody = { error: message };
  return buildJsonResponse(statusCode, body, allowOrigin);
}
