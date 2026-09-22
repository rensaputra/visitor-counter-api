/**
 * Tests for the handler entry point (`src/index.ts`): the exported `handler`.
 *
 * These tests exercise the fully wired Lambda handler end to end, mocking the
 * `DynamoDBClient` with `aws-sdk-client-mock` so no live Data_Store is touched
 * (Requirement 10.2), and using `fast-check` for the property-based tests
 * (each `fc.assert` runs a minimum of 100 iterations).
 *
 * Task coverage:
 * - 9.2 Property 2: Successful increment response shape (Req 1.3).
 * - 9.3 Property 4: Successful read response shape (Req 2.3).
 * - 9.4 Integration: global-counter routing and graceful init (Req 1.2, 2.2, 5.2).
 * - 9.5 Integration: error and edge paths (Req 3.3, 7.x, 8.1, 8.2, 10.1, 10.4, 10.5).
 */

import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { handler } from "./index";
import { GLOBAL_COUNTER_KEY } from "./input";

const ddbMock = mockClient(DynamoDBClient);
const TABLE_NAME = "visitor-counter-table";

/**
 * Snapshot and restore the environment variables the handler reads, so each
 * test controls TABLE_NAME / ALLOW_ORIGIN in isolation.
 */
let savedEnv: { TABLE_NAME: string | undefined; ALLOW_ORIGIN: string | undefined };

beforeEach(() => {
  ddbMock.reset();
  savedEnv = {
    TABLE_NAME: process.env.TABLE_NAME,
    ALLOW_ORIGIN: process.env.ALLOW_ORIGIN,
  };
  process.env.TABLE_NAME = TABLE_NAME;
  delete process.env.ALLOW_ORIGIN;
});

afterEach(() => {
  if (savedEnv.TABLE_NAME === undefined) {
    delete process.env.TABLE_NAME;
  } else {
    process.env.TABLE_NAME = savedEnv.TABLE_NAME;
  }
  if (savedEnv.ALLOW_ORIGIN === undefined) {
    delete process.env.ALLOW_ORIGIN;
  } else {
    process.env.ALLOW_ORIGIN = savedEnv.ALLOW_ORIGIN;
  }
});

/**
 * Build a minimal APIGatewayProxyEventV2 (payload format 2.0) carrying the
 * fields the handler reads: HTTP method at `requestContext.http.method`,
 * `queryStringParameters`, `body`, and `isBase64Encoded`.
 */
function buildEvent(options: {
  method: string;
  query?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  const { method, query, body, isBase64Encoded } = options;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { "content-type": "application/json" },
    queryStringParameters: query,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.com",
      domainPrefix: "example",
      http: {
        method,
        path: "/",
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "jest",
      },
      requestId: "req-id",
      routeKey: "$default",
      stage: "$default",
      time: "01/Jan/2024:00:00:00 +0000",
      timeEpoch: 1704067200000,
    },
    body,
    isBase64Encoded: isBase64Encoded ?? false,
  } as unknown as APIGatewayProxyEventV2;
}

/** Parse the JSON body of a handler result. */
function parseBody(result: APIGatewayProxyStructuredResultV2): unknown {
  return JSON.parse(result.body ?? "");
}

/** True when `value` is a non-negative integer. */
function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** True when `value` is a string that parses as a valid ISO 8601 timestamp. */
function isValidIsoTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}

/** A non-negative integer Count, covering zero and large values. */
const countArb = fc.integer({ min: 0, max: 1_000_000 });

/** An ISO 8601 timestamp string. */
const isoTimestampArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

describe("handler: successful increment response shape (Task 9.2)", () => {
  // Feature: visitor-counter-api, Property 2: Successful increment response shape
  it("responds 200 with a non-negative integer count and a valid ISO 8601 updatedAt for any successful increment", async () => {
    await fc.assert(
      fc.asyncProperty(countArb, isoTimestampArb, async (count, updatedAt) => {
        ddbMock.reset();
        // Arbitrary post-increment Attributes (UPDATED_NEW).
        ddbMock.on(UpdateItemCommand).resolves({
          Attributes: {
            count: { N: String(count) },
            updatedAt: { S: updatedAt },
          },
        });

        const result = await handler(buildEvent({ method: "POST" }));

        expect(result.statusCode).toBe(200);
        const body = parseBody(result) as { count: unknown; updatedAt: unknown };
        expect(isNonNegativeInteger(body.count)).toBe(true);
        expect(isValidIsoTimestamp(body.updatedAt)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

describe("handler: successful read response shape (Task 9.3)", () => {
  // Feature: visitor-counter-api, Property 4: Successful read response shape
  it("responds 200 with a non-negative integer count and updatedAt that is a valid ISO 8601 string or null for any successful read", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Either a present record (arbitrary count + optional updatedAt) or an
        // absent record.
        fc.oneof(
          fc.record({
            present: fc.constant(true),
            count: countArb,
            updatedAt: fc.oneof(isoTimestampArb, fc.constant<null>(null)),
          }),
          fc.record({ present: fc.constant(false) }),
        ),
        async (scenario) => {
          ddbMock.reset();

          if (scenario.present) {
            const item: Record<string, { S: string } | { N: string }> = {
              pageId: { S: GLOBAL_COUNTER_KEY },
              count: { N: String(scenario.count) },
            };
            if (scenario.updatedAt !== null) {
              item.updatedAt = { S: scenario.updatedAt };
            }
            ddbMock.on(GetItemCommand).resolves({ Item: item });
          } else {
            ddbMock.on(GetItemCommand).resolves({});
          }

          const result = await handler(buildEvent({ method: "GET" }));

          expect(result.statusCode).toBe(200);
          const body = parseBody(result) as {
            count: unknown;
            updatedAt: unknown;
          };
          expect(isNonNegativeInteger(body.count)).toBe(true);
          expect(
            body.updatedAt === null || isValidIsoTimestamp(body.updatedAt),
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("handler: global-counter routing and graceful init (Task 9.4)", () => {
  it("routes a POST with no selector to the reserved global key", async () => {
    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: {
        count: { N: "1" },
        updatedAt: { S: "2024-01-01T00:00:00.000Z" },
      },
    });

    const result = await handler(buildEvent({ method: "POST" }));

    expect(result.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(UpdateItemCommand);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one UpdateItem call");
    expect(call.args[0].input.Key).toEqual({
      pageId: { S: GLOBAL_COUNTER_KEY },
    });
    expect(GLOBAL_COUNTER_KEY).toBe("*global*");
  });

  it("routes a GET with no selector to the reserved global key", async () => {
    ddbMock.on(GetItemCommand).resolves({
      Item: {
        pageId: { S: GLOBAL_COUNTER_KEY },
        count: { N: "42" },
        updatedAt: { S: "2024-01-01T00:00:00.000Z" },
      },
    });

    const result = await handler(buildEvent({ method: "GET" }));

    expect(result.statusCode).toBe(200);
    const calls = ddbMock.commandCalls(GetItemCommand);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one GetItem call");
    expect(call.args[0].input.Key).toEqual({
      pageId: { S: GLOBAL_COUNTER_KEY },
    });
    expect((parseBody(result) as { count: number }).count).toBe(42);
  });

  it("returns { count: 0, updatedAt: null } for a GET with no selector against an absent global record", async () => {
    ddbMock.on(GetItemCommand).resolves({});

    const result = await handler(buildEvent({ method: "GET" }));

    expect(result.statusCode).toBe(200);
    expect(parseBody(result)).toEqual({ count: 0, updatedAt: null });
    // Graceful init never issues a write.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });
});

describe("handler: error and edge paths (Task 9.5)", () => {
  it("responds 405 with an error body for an unsupported method (Req 8.1, 10.4)", async () => {
    const result = await handler(buildEvent({ method: "DELETE" }));

    expect(result.statusCode).toBe(405);
    expect(parseBody(result)).toEqual({ error: "Method not supported" });
    // No Data_Store interaction on an unsupported method.
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("responds 400 for an invalid JSON body (Req 7.1)", async () => {
    const result = await handler(
      buildEvent({ method: "POST", body: "{not valid json" }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result)).toEqual({
      error: "Request body is not valid JSON",
    });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("responds 400 for an over-length pageId via the query param (Req 7.2)", async () => {
    const tooLong = "a".repeat(129);
    const result = await handler(
      buildEvent({ method: "GET", query: { page: tooLong } }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result)).toEqual({
      error: "pageId exceeds the maximum length of 128 code points",
    });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("responds 400 for a disallowed-chars pageId via the query param (Req 7.3)", async () => {
    const result = await handler(
      buildEvent({ method: "GET", query: { page: "bad id!" } }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result)).toEqual({
      error: "pageId contains disallowed characters",
    });
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  it("responds 400 for an over-size request body before parsing (Req 7.6)", async () => {
    // 8193 bytes of ASCII exceeds the 8192-byte cap.
    const oversize = "x".repeat(8193);
    const result = await handler(
      buildEvent({ method: "POST", body: oversize }),
    );

    expect(result.statusCode).toBe(400);
    expect(parseBody(result)).toEqual({
      error: "Request body exceeds the maximum allowed size",
    });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });

  it("responds 500 with the increment error message when the increment rejects (Req 3.3, 8.2)", async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error("DynamoDB unavailable"));

    const result = await handler(
      buildEvent({ method: "POST", query: { page: "page-1" } }),
    );

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({
      error: "Increment could not be recorded",
    });
    // Exactly one command attempted, no partial write via another path.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  it("responds 500 for a conflict/throttle-style rejection on increment (Req 3.3)", async () => {
    const conflict = Object.assign(
      new Error("throughput exceeded"),
      { name: "ProvisionedThroughputExceededException" },
    );
    ddbMock.on(UpdateItemCommand).rejects(conflict);

    const result = await handler(
      buildEvent({ method: "POST", query: { page: "page-1" } }),
    );

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({
      error: "Increment could not be recorded",
    });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  it("responds 500 with the read error message when the read rejects (Req 2.4)", async () => {
    ddbMock.on(GetItemCommand).rejects(new Error("DynamoDB unavailable"));

    const result = await handler(
      buildEvent({ method: "GET", query: { page: "page-1" } }),
    );

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({ error: "Count could not be read" });
  });

  describe("Requirement 10.1 enumerated status/body shapes", () => {
    it("increment: 200 with { count, updatedAt }", async () => {
      ddbMock.on(UpdateItemCommand).resolves({
        Attributes: {
          count: { N: "5" },
          updatedAt: { S: "2024-01-01T00:00:00.000Z" },
        },
      });

      const result = await handler(
        buildEvent({ method: "POST", query: { page: "page-1" } }),
      );

      expect(result.statusCode).toBe(200);
      expect(parseBody(result)).toEqual({
        count: 5,
        updatedAt: "2024-01-01T00:00:00.000Z",
      });
    });

    it("read: 200 with { count, updatedAt }", async () => {
      ddbMock.on(GetItemCommand).resolves({
        Item: {
          pageId: { S: "page-1" },
          count: { N: "7" },
          updatedAt: { S: "2024-02-02T00:00:00.000Z" },
        },
      });

      const result = await handler(
        buildEvent({ method: "GET", query: { page: "page-1" } }),
      );

      expect(result.statusCode).toBe(200);
      expect(parseBody(result)).toEqual({
        count: 7,
        updatedAt: "2024-02-02T00:00:00.000Z",
      });
    });

    it("graceful init: 200 with { count: 0, updatedAt: null }", async () => {
      ddbMock.on(GetItemCommand).resolves({});

      const result = await handler(
        buildEvent({ method: "GET", query: { page: "new-page" } }),
      );

      expect(result.statusCode).toBe(200);
      expect(parseBody(result)).toEqual({ count: 0, updatedAt: null });
    });

    it("CORS: every response carries an Access-Control-Allow-Origin header", async () => {
      ddbMock.on(GetItemCommand).resolves({});

      // Success response.
      const ok = await handler(
        buildEvent({ method: "GET", query: { page: "page-1" } }),
      );
      expect(ok.headers?.["Access-Control-Allow-Origin"]).toBe("*");

      // Error response.
      const err = await handler(buildEvent({ method: "DELETE" }));
      expect(err.headers?.["Access-Control-Allow-Origin"]).toBe("*");

      // OPTIONS now classifies as OTHER (preflight is owned by the HTTP API
      // gateway and never reaches the Handler), so it responds 405 while still
      // carrying the CORS header.
      const options = await handler(buildEvent({ method: "OPTIONS" }));
      expect(options.statusCode).toBe(405);
      expect(options.headers?.["Access-Control-Allow-Origin"]).toBe("*");
    });

    it("CORS: reflects the ALLOW_ORIGIN environment variable in the header", async () => {
      process.env.ALLOW_ORIGIN = "https://example.com";
      ddbMock.on(GetItemCommand).resolves({});

      const result = await handler(
        buildEvent({ method: "GET", query: { page: "page-1" } }),
      );

      expect(result.headers?.["Access-Control-Allow-Origin"]).toBe(
        "https://example.com",
      );
    });

    it("sanitization: 400 with an error body for invalid input (Req 10.5)", async () => {
      const result = await handler(
        buildEvent({ method: "GET", query: { page: "bad id!" } }),
      );

      expect(result.statusCode).toBe(400);
      const body = parseBody(result) as { error: unknown };
      expect(typeof body.error).toBe("string");
    });
  });
});

describe("handler: CORS on every response (Task 3.2)", () => {
  // Feature: visitor-counter-api, Property 11: Every Handler response carries the resolved Allow_Origin header
  // Validates: Requirements 6.4, 8.1, 8.2
  it("attaches the resolved Allow_Origin header to GET/POST/OTHER/error responses for any configured origin", async () => {
    const originArb = fc.oneof(
      fc.constant<string | undefined>(undefined),
      fc.constantFrom("*", "https://example.com", "https://app.test"),
    );

    // Each scenario drives a distinct Handler code path (GET success, POST
    // success, OTHER→405, and both 400 and 500 error envelopes) so the
    // property holds across the full set of response classes.
    const scenarioArb = fc.constantFrom(
      "get-ok",
      "post-ok",
      "other-405",
      "bad-request-400",
      "read-error-500",
    );

    await fc.assert(
      fc.asyncProperty(originArb, scenarioArb, async (origin, scenario) => {
        ddbMock.reset();
        if (origin === undefined) {
          delete process.env.ALLOW_ORIGIN;
        } else {
          process.env.ALLOW_ORIGIN = origin;
        }
        const expected = origin ?? "*";

        let result: APIGatewayProxyStructuredResultV2;
        switch (scenario) {
          case "get-ok":
            ddbMock.on(GetItemCommand).resolves({
              Item: {
                pageId: { S: GLOBAL_COUNTER_KEY },
                count: { N: "3" },
                updatedAt: { S: "2024-01-01T00:00:00.000Z" },
              },
            });
            result = await handler(buildEvent({ method: "GET" }));
            expect(result.statusCode).toBe(200);
            break;
          case "post-ok":
            ddbMock.on(UpdateItemCommand).resolves({
              Attributes: {
                count: { N: "4" },
                updatedAt: { S: "2024-01-01T00:00:00.000Z" },
              },
            });
            result = await handler(buildEvent({ method: "POST" }));
            expect(result.statusCode).toBe(200);
            break;
          case "other-405":
            result = await handler(buildEvent({ method: "DELETE" }));
            expect(result.statusCode).toBe(405);
            break;
          case "bad-request-400":
            result = await handler(
              buildEvent({ method: "GET", query: { page: "bad id!" } }),
            );
            expect(result.statusCode).toBe(400);
            break;
          case "read-error-500":
            ddbMock.on(GetItemCommand).rejects(new Error("boom"));
            result = await handler(buildEvent({ method: "GET" }));
            expect(result.statusCode).toBe(500);
            break;
          default:
            throw new Error(`unhandled scenario: ${scenario}`);
        }

        expect(result.headers?.["Access-Control-Allow-Origin"]).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});

describe("handler: generic unexpected-error handling (Task coverage: index.ts catch-all)", () => {
  // Covers the generic 500 catch arm (any non-DataStoreError). An event whose
  // `requestContext.http` is missing makes `event.requestContext.http.method`
  // throw a TypeError inside the try block, which is not a DataStoreError, so
  // the top-level catch maps it to 500 "Request could not be processed" with
  // CORS headers still attached (Requirement 8.2).
  it("responds 500 'Request could not be processed' for an unexpected error, with CORS headers", async () => {
    const malformed = {
      version: "2.0",
      // requestContext is present but has no `http`, so accessing
      // requestContext.http.method throws a TypeError.
      requestContext: {},
    } as unknown as APIGatewayProxyEventV2;

    const result = await handler(malformed);

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({
      error: "Request could not be processed",
    });
    // CORS header is attached even on the unexpected-error path.
    expect(result.headers?.["Access-Control-Allow-Origin"]).toBe("*");
    // No Data_Store interaction occurred.
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
  });
});

describe("handler: structured logging on 500 paths (Task 10.3)", () => {
  // These tests assert the observability behavior added in tasks 10.1/10.2:
  // every 500 path emits exactly one structured JSON log to console.error whose
  // parsed object carries the correct `operation` and the underlying error's
  // name/message/stack, while the client-facing 500 body stays the fixed
  // generic message with no internal detail. The 400/405 paths return before
  // the top-level catch and must never log (Requirements 8.4, 8.5, 8.6).
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** Parse the single logged JSON payload, asserting exactly one call. */
  function parseSoleLog(): {
    level: unknown;
    operation: unknown;
    name: unknown;
    message: unknown;
    stack: unknown;
  } {
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const arg = errorSpy.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    return JSON.parse(arg as string);
  }

  it("logs exactly once for a READ failure with the underlying error's name/message/stack, and returns the generic 500 body", async () => {
    const underlying = new Error("DynamoDB unavailable");
    ddbMock.on(GetItemCommand).rejects(underlying);

    const result = await handler(
      buildEvent({ method: "GET", query: { page: "page-1" } }),
    );

    // (b) Client-facing body is the fixed generic message, no internal detail.
    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({ error: "Count could not be read" });

    // (a) Exactly one structured log with the expected operation + error fields.
    const log = parseSoleLog();
    expect(log.level).toBe("error");
    expect(log.operation).toBe("READ");
    expect(log.name).toBe(underlying.name);
    expect(log.message).toBe(underlying.message);
    expect(log.stack).toBe(underlying.stack);
  });

  it("logs exactly once for an INCREMENT failure with the underlying error's name/message/stack, and returns the generic 500 body", async () => {
    const underlying = new Error("DynamoDB unavailable");
    ddbMock.on(UpdateItemCommand).rejects(underlying);

    const result = await handler(
      buildEvent({ method: "POST", query: { page: "page-1" } }),
    );

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({
      error: "Increment could not be recorded",
    });

    const log = parseSoleLog();
    expect(log.level).toBe("error");
    expect(log.operation).toBe("INCREMENT");
    expect(log.name).toBe(underlying.name);
    expect(log.message).toBe(underlying.message);
    expect(log.stack).toBe(underlying.stack);
  });

  it("logs exactly once for the unexpected-error path with the error's name/message/stack, and returns the generic 500 body", async () => {
    // A malformed event with no `requestContext.http` makes the handler throw a
    // TypeError inside the try block; it is not a DataStoreError, so the
    // catch-all maps it to UNEXPECTED.
    const malformed = {
      version: "2.0",
      requestContext: {},
    } as unknown as APIGatewayProxyEventV2;

    const result = await handler(malformed);

    expect(result.statusCode).toBe(500);
    expect(parseBody(result)).toEqual({
      error: "Request could not be processed",
    });

    const log = parseSoleLog();
    expect(log.level).toBe("error");
    expect(log.operation).toBe("UNEXPECTED");
    // The underlying error is a real Error (TypeError) with a populated
    // name/message/stack; assert the fields are the expected types/shape.
    expect(log.name).toBe("TypeError");
    expect(typeof log.message).toBe("string");
    expect(typeof log.stack).toBe("string");
  });

  it("does not log on a 400 (invalid input) path", async () => {
    const result = await handler(
      buildEvent({ method: "GET", query: { page: "bad id!" } }),
    );

    expect(result.statusCode).toBe(400);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not log on a 405 (unsupported method) path", async () => {
    const result = await handler(buildEvent({ method: "DELETE" }));

    expect(result.statusCode).toBe(405);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
