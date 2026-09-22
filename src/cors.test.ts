import fc from "fast-check";
import { resolveAllowOrigin, corsHeaders } from "./cors";

// Feature: visitor-counter-api, Property 10: Allow_Origin resolution
//
// For any environment, the resolved Allow_Origin equals the ALLOW_ORIGIN value
// when it is a non-empty string and equals * when ALLOW_ORIGIN is unset or
// empty; this resolved value appears in the CORS headers.
//
// Validates: Requirements 6.1, 6.2
describe("Property 10: Allow_Origin resolution", () => {
  it("resolves ALLOW_ORIGIN and surfaces it in the CORS headers", () => {
    // Arbitrary describing the three shapes ALLOW_ORIGIN can take:
    //  - a non-empty string  (Req 6.1)
    //  - the empty string     (Req 6.2)
    //  - unset / undefined    (Req 6.2)
    const allowOriginArb = fc.oneof(
      fc.string({ minLength: 1 }).filter((s) => s.length > 0),
      fc.constant(""),
      fc.constant(undefined)
    );

    // Extra, unrelated environment variables should not affect resolution.
    const extraEnvArb = fc.dictionary(
      fc.string().filter((k) => k !== "ALLOW_ORIGIN"),
      fc.string()
    );

    fc.assert(
      fc.property(allowOriginArb, extraEnvArb, (allowOrigin, extraEnv) => {
        const env: Record<string, string | undefined> = { ...extraEnv };
        if (allowOrigin !== undefined) {
          env.ALLOW_ORIGIN = allowOrigin;
        }

        const resolved = resolveAllowOrigin(env);

        // Expected resolution per Req 6.1 / 6.2.
        const expected =
          typeof allowOrigin === "string" && allowOrigin.length > 0
            ? allowOrigin
            : "*";
        expect(resolved).toBe(expected);

        // The resolved value must appear in the CORS headers (Req 6.1, 6.2).
        const headers = corsHeaders(resolved);
        expect(headers["Access-Control-Allow-Origin"]).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });
});
