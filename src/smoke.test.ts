/**
 * Tests for the smoke-test assertion logic (`src/smoke.ts`).
 *
 * These exercise the pure `validateCall` / `evaluateChecks` functions with both
 * example-based cases (valid body, wrong-shape bodies, non-2xx status) and
 * property-based checks (any 2xx + valid shape passes; any non-2xx fails),
 * mirroring the project's existing fast-check style. No network calls are made;
 * the network runner (scripts/smoke-test.mjs) is a thin wrapper over these.
 */

import fc from "fast-check";
import { validateCall, evaluateChecks } from "./smoke";

describe("validateCall", () => {
  it("passes a 2xx response with integer count and ISO updatedAt", () => {
    const result = validateCall({
      name: "GET /",
      status: 200,
      body: { count: 42, updatedAt: "2026-10-26T00:00:00.000Z" },
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("passes when updatedAt is null (never-incremented counter)", () => {
    const result = validateCall({
      name: "GET /",
      status: 200,
      body: { count: 0, updatedAt: null },
    });
    expect(result.ok).toBe(true);
  });

  it("fails on a non-2xx status", () => {
    const result = validateCall({
      name: "GET /",
      status: 500,
      body: { count: 1, updatedAt: null },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("2xx");
  });

  it("fails when the body is not a JSON object", () => {
    const result = validateCall({ name: "GET /", status: 200, body: "nope" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("JSON object");
  });

  it("fails when count is missing or not a non-negative integer", () => {
    expect(
      validateCall({ name: "GET /", status: 200, body: { updatedAt: null } }).ok
    ).toBe(false);
    expect(
      validateCall({
        name: "GET /",
        status: 200,
        body: { count: -1, updatedAt: null },
      }).reason
    ).toContain("count");
    expect(
      validateCall({
        name: "GET /",
        status: 200,
        body: { count: 1.5, updatedAt: null },
      }).ok
    ).toBe(false);
  });

  it("fails when updatedAt is neither string nor null", () => {
    const result = validateCall({
      name: "POST /",
      status: 200,
      body: { count: 1, updatedAt: 123 },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("updatedAt");
  });
});

describe("validateCall properties", () => {
  it("accepts any 2xx status with a valid body shape", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 200, max: 299 }),
        fc.nat(),
        fc.option(fc.date().map((d) => d.toISOString()), { nil: null }),
        (status, count, updatedAt) => {
          const result = validateCall({
            name: "GET /",
            status,
            body: { count, updatedAt },
          });
          return result.ok === true;
        }
      )
    );
  });

  it("rejects any status outside 2xx regardless of body", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: 100, max: 199 }),
          fc.integer({ min: 300, max: 599 })
        ),
        fc.nat(),
        (status, count) => {
          const result = validateCall({
            name: "GET /",
            status,
            body: { count, updatedAt: null },
          });
          return result.ok === false;
        }
      )
    );
  });
});

describe("evaluateChecks", () => {
  it("passes only when every check passes", () => {
    const allGood = evaluateChecks([
      { name: "GET /", status: 200, body: { count: 1, updatedAt: null } },
      { name: "POST /", status: 200, body: { count: 2, updatedAt: "x" } },
    ]);
    expect(allGood.passed).toBe(true);
    expect(allGood.results).toHaveLength(2);

    const oneBad = evaluateChecks([
      { name: "GET /", status: 200, body: { count: 1, updatedAt: null } },
      { name: "POST /", status: 502, body: { count: 2, updatedAt: "x" } },
    ]);
    expect(oneBad.passed).toBe(false);
    expect(oneBad.results.find((r) => r.name === "POST /")?.ok).toBe(false);
  });
});
