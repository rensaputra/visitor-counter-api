/**
 * Router: HTTP method classification.
 *
 * A pure-logic layer that maps the raw HTTP method string from the incoming
 * event to a normalized {@link Method}. Keeping this logic pure (no I/O) makes
 * method handling and unsupported-method (405) behavior directly testable.
 */

import type { Method } from "./types";

/**
 * Classify a raw HTTP method string into a normalized {@link Method}.
 *
 * The comparison is case-insensitive (Requirement 8.1): any method whose
 * uppercased value is `GET` or `POST` is classified as such; every other
 * value (including empty or whitespace-only strings) is classified as
 * `OTHER`, which the handler maps to HTTP 405. OPTIONS is intentionally not
 * a handled case: OPTIONS preflight is answered by the HTTP API at the edge
 * and does not reach the Handler, so any OPTIONS request that does arrive
 * falls through to `OTHER`.
 *
 * @param rawMethod - The HTTP method as received from the request event.
 * @returns The classified method: `GET`, `POST`, or `OTHER`.
 */
export function classifyMethod(rawMethod: string): Method {
  switch (rawMethod.toUpperCase()) {
    case "GET":
      return "GET";
    case "POST":
      return "POST";
    default:
      return "OTHER";
  }
}
