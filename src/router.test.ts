/**
 * Property-based tests for the router (method classification).
 */

import fc from "fast-check";
import { classifyMethod } from "./router";
import type { Method } from "./types";

const SUPPORTED: readonly Method[] = ["GET", "POST"];

/**
 * Randomly re-case each character of a string so we exercise mixed-case
 * variants (e.g. "gEt", "Post", "oPTIONs") rather than only upper/lower.
 */
function casedVariant(base: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: base.length, maxLength: base.length })
    .map((flags) =>
      [...base]
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

describe("classifyMethod", () => {
  // Feature: visitor-counter-api, Property 17: Method classification and unsupported-method rejection
  it("classifies case-insensitive GET/POST variants as supported", () => {
    const supportedCased = fc
      .constantFrom<Method>("GET", "POST")
      .chain((canonical) =>
        casedVariant(canonical).map((cased) => ({ canonical, cased })),
      );

    fc.assert(
      fc.property(supportedCased, ({ canonical, cased }) => {
        expect(classifyMethod(cased)).toBe(canonical);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 17: Method classification and unsupported-method rejection
  it("classifies arbitrary non-supported method strings as OTHER", () => {
    const supportedUpper = new Set<string>(SUPPORTED);

    fc.assert(
      fc.property(fc.string(), (raw) => {
        // Only assert for methods that are NOT a case-insensitive supported one.
        fc.pre(!supportedUpper.has(raw.toUpperCase()));
        expect(classifyMethod(raw)).toBe("OTHER");
      }),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 17: Method classification and unsupported-method rejection
  it("classifies OPTIONS (and cased variants) as OTHER", () => {
    // OPTIONS preflight is answered by the HTTP API at the edge and never
    // reaches the Handler; any OPTIONS that does arrive must fall through to
    // OTHER (which the Handler maps to 405).
    expect(classifyMethod("OPTIONS")).toBe("OTHER");
    expect(classifyMethod("options")).toBe("OTHER");
    expect(classifyMethod("Options")).toBe("OTHER");

    fc.assert(
      fc.property(casedVariant("OPTIONS"), (cased) => {
        expect(classifyMethod(cased)).toBe("OTHER");
      }),
      { numRuns: 200 },
    );
  });
});
