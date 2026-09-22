import fc from "fast-check";
import { buildJsonResponse, buildErrorResponse } from "./response";

// Feature: visitor-counter-api, Property 12: Every response carries the resolved Allow_Origin header
//
// For any request (any method, any validity, any success or failure outcome)
// and any environment, the returned response includes an
// Access-Control-Allow-Origin header whose value equals the resolved
// Allow_Origin, regardless of the HTTP status code.
//
// Validates: Requirements 6.4
describe("Property 12: Every response carries the resolved Allow_Origin header", () => {
  // Arbitrary HTTP status codes spanning the full response surface (2xx–5xx),
  // so the property covers success (200), preflight-adjacent, client-error
  // (400/405), and server-error (500) outcomes alike.
  const statusCodeArb = fc.integer({ min: 100, max: 599 });

  // Arbitrary resolved Allow_Origin strings, including "*", concrete origins,
  // and arbitrary strings — the value the builders must echo back verbatim.
  const allowOriginArb = fc.oneof(
    fc.constant("*"),
    fc.webUrl(),
    fc.string()
  );

  it("buildJsonResponse always includes Access-Control-Allow-Origin and JSON content type", () => {
    // Arbitrary JSON-serializable bodies covering the shapes the success path
    // produces (counter bodies) plus arbitrary values.
    const bodyArb = fc.oneof(
      fc.record({
        count: fc.nat(),
        updatedAt: fc.option(fc.date().map((d) => d.toISOString()), {
          nil: null,
        }),
      }),
      fc.object(),
      fc.anything()
    );

    fc.assert(
      fc.property(
        statusCodeArb,
        bodyArb,
        allowOriginArb,
        (statusCode, body, allowOrigin) => {
          const response = buildJsonResponse(statusCode, body, allowOrigin);

          const headers = response.headers ?? {};

          // The resolved Allow_Origin appears verbatim, regardless of status.
          expect(headers["Access-Control-Allow-Origin"]).toBe(allowOrigin);

          // The response always advertises JSON content.
          expect(headers["Content-Type"]).toBe("application/json");

          // The status code is preserved as passed.
          expect(response.statusCode).toBe(statusCode);
        }
      ),
      { numRuns: 200 }
    );
  });

  it("buildErrorResponse always includes Access-Control-Allow-Origin and JSON content type", () => {
    fc.assert(
      fc.property(
        statusCodeArb,
        fc.string(),
        allowOriginArb,
        (statusCode, message, allowOrigin) => {
          const response = buildErrorResponse(statusCode, message, allowOrigin);

          const headers = response.headers ?? {};

          // The resolved Allow_Origin appears verbatim, regardless of status.
          expect(headers["Access-Control-Allow-Origin"]).toBe(allowOrigin);

          // Error responses also carry the JSON content type.
          expect(headers["Content-Type"]).toBe("application/json");

          // The status code is preserved as passed.
          expect(response.statusCode).toBe(statusCode);
        }
      ),
      { numRuns: 200 }
    );
  });
});
