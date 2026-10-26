/**
 * Post-deploy smoke test for the Visitor Counter API.
 *
 * Usage:
 *   node scripts/smoke-test.mjs <baseUrl>
 *   API_ENDPOINT=<baseUrl> node scripts/smoke-test.mjs
 *
 * Performs a live `GET /` and `POST /` against the given base URL and asserts
 * each returns an HTTP 2xx status with a JSON body matching the Visitor Counter
 * API success contract: a non-negative-integer `count` and an `updatedAt` that
 * is a string or `null`. Exits 0 when both calls pass, or non-zero with a clear
 * message on the first failure.
 *
 * The assertion logic below is a faithful, dependency-free mirror of the pure
 * `validateCall` function in `src/smoke.ts`, which is unit-tested under Jest and
 * counted toward the project's coverage thresholds. Keep the two in sync: the
 * TypeScript module is the source of truth for the contract, and this runner
 * adds only the network and reporting layer so it can run in CI with plain Node
 * (no TypeScript build step required).
 */

/**
 * Validate one endpoint call against the success contract.
 * Mirror of validateCall in src/smoke.ts.
 *
 * @param {{ name: string, status: number, body: unknown }} check
 * @returns {{ name: string, ok: boolean, reason: string | null }}
 */
function validateCall(check) {
  const fail = (reason) => ({ name: check.name, ok: false, reason });

  if (check.status < 200 || check.status > 299) {
    return fail(`expected 2xx status, got ${check.status}`);
  }
  if (typeof check.body !== "object" || check.body === null) {
    return fail("response body is not a JSON object");
  }
  const body = /** @type {Record<string, unknown>} */ (check.body);
  const count = body["count"];
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return fail(
      `"count" must be a non-negative integer, got ${JSON.stringify(count)}`
    );
  }
  const updatedAt = body["updatedAt"];
  if (updatedAt !== null && typeof updatedAt !== "string") {
    return fail(
      `"updatedAt" must be a string or null, got ${JSON.stringify(updatedAt)}`
    );
  }
  return { name: check.name, ok: true, reason: null };
}

/**
 * Perform one HTTP request and parse its JSON body (tolerating non-JSON).
 *
 * @param {string} name   Label for the check, e.g. "GET /".
 * @param {string} url    Fully-qualified request URL.
 * @param {RequestInit} init  fetch options (method, headers, body).
 * @returns {Promise<{ name: string, status: number, body: unknown }>}
 */
async function call(name, url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = text; // non-JSON; validateCall will flag the shape failure
  }
  return { name, status: res.status, body };
}

async function main() {
  const baseUrl = (process.argv[2] ?? process.env.API_ENDPOINT ?? "").trim();
  if (baseUrl === "") {
    console.error(
      "Usage: node scripts/smoke-test.mjs <baseUrl>  (or set API_ENDPOINT)"
    );
    process.exit(2);
  }

  // Normalize so GET/POST target the API root "/" regardless of trailing slash.
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  console.log(`Smoke testing ${root}`);

  const checks = [
    await call("GET /", root, { method: "GET" }),
    await call("POST /", root, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }),
  ];

  let passed = true;
  for (const check of checks) {
    const result = validateCall(check);
    if (result.ok) {
      console.log(`  PASS  ${result.name} (status ${check.status})`);
    } else {
      passed = false;
      console.error(`  FAIL  ${result.name}: ${result.reason}`);
    }
  }

  if (!passed) {
    console.error("Smoke test failed.");
    process.exit(1);
  }
  console.log("Smoke test passed.");
}

main().catch((err) => {
  console.error(`Smoke test errored: ${err?.message ?? err}`);
  process.exit(1);
});
