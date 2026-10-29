/**
 * Smoke-test assertion logic for the Visitor Counter API.
 *
 * Pure logic (no I/O): given an HTTP status code and a parsed JSON body, decide
 * whether a single endpoint call satisfies the Visitor Counter API's success
 * contract. The network-performing runner (scripts/smoke-test.mjs) imports the
 * built form of this module so the exact same checks run in CI against the live
 * deployed API, while this TypeScript source is unit-tested under Jest (and
 * counted toward the project's coverage thresholds via collectCoverageFrom).
 *
 * The success contract mirrors the Handler's 200 body
 * ({@link CounterResponseBody} in src/types.ts): `count` is a non-negative
 * integer and `updatedAt` is either an ISO 8601 string or `null` (a
 * never-incremented counter legitimately reports `null` on GET), so the
 * validator accepts `null` rather than failing a freshly created counter.
 */

/** A single named check performed by the smoke test (one per endpoint call). */
export interface SmokeCheck {
  /** Human-readable label, e.g. "GET /" or "POST /". */
  readonly name: string;
  /** HTTP status code returned by the call. */
  readonly status: number;
  /** Parsed JSON body returned by the call (or the raw value if not JSON). */
  readonly body: unknown;
}

/** The outcome of validating one {@link SmokeCheck}. */
export interface SmokeResult {
  readonly name: string;
  readonly ok: boolean;
  /** Failure reason when `ok` is false; `null` on success. */
  readonly reason: string | null;
}

/** True when `value` is a non-negative integer (the `count` contract). */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True when `value` is a string or `null` (the `updatedAt` contract). */
function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Validate one endpoint call against the Visitor Counter API success contract.
 *
 * A call passes when BOTH:
 * - the status code is in the 2xx range, and
 * - the body is a JSON object with a non-negative-integer `count` and an
 *   `updatedAt` that is a string or `null`.
 *
 * Returns a {@link SmokeResult}; on failure, `reason` describes the first
 * violation encountered (status before shape), suitable for printing in CI.
 */
export function validateCall(check: SmokeCheck): SmokeResult {
  const fail = (reason: string): SmokeResult => ({
    name: check.name,
    ok: false,
    reason,
  });

  if (check.status < 200 || check.status > 299) {
    return fail(`expected 2xx status, got ${check.status}`);
  }

  if (typeof check.body !== "object" || check.body === null) {
    return fail("response body is not a JSON object");
  }

  const body = check.body as Record<string, unknown>;

  if (!isNonNegativeInteger(body["count"])) {
    return fail(
      `"count" must be a non-negative integer, got ${JSON.stringify(
        body["count"]
      )}`
    );
  }

  if (!isStringOrNull(body["updatedAt"])) {
    return fail(
      `"updatedAt" must be a string or null, got ${JSON.stringify(
        body["updatedAt"]
      )}`
    );
  }

  return { name: check.name, ok: true, reason: null };
}

/**
 * Validate a batch of endpoint calls (e.g. GET and POST).
 *
 * Returns `{ passed, results }` where `passed` is true only when every call
 * passed. The runner uses `passed` to set its process exit code and prints each
 * result's reason for the failures.
 */
export function evaluateChecks(checks: readonly SmokeCheck[]): {
  passed: boolean;
  results: SmokeResult[];
} {
  const results = checks.map(validateCall);
  return { passed: results.every((r) => r.ok), results };
}
