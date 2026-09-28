/**
 * Handler entry point for the Visitor Counter API.
 *
 * This is the only module that touches the AWS SDK and reads environment
 * variables. It constructs the {@link DynamoDBClient} once at module scope
 * (reused across warm Lambda invocations), resolves CORS configuration,
 * classifies the HTTP method, routes to the appropriate operation, and wraps
 * all routing in a single top-level try/catch so no code path can escape
 * without a CORS-bearing JSON response.
 *
 * Layering: the handler delegates all pure logic to the CORS, response,
 * router, input, and counter modules. It contributes the I/O boundary,
 * validation ordering, and error-class-to-status mapping.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

import { resolveAllowOrigin } from "./cors";
import { buildJsonResponse, buildErrorResponse } from "./response";
import { classifyMethod } from "./router";
import {
  resolveTarget,
  deriveCounterKey,
  validatePageId,
  parseBody,
} from "./input";
import { readCount, incrementCount } from "./counter";
import type {
  CounterKey,
  CounterResponseBody,
  CounterResult,
  ValidationError,
} from "./types";

/**
 * Module-scoped DynamoDB client, constructed once and reused across warm
 * invocations. The SDK resolves region and credentials from the Lambda
 * execution environment.
 *
 * For local development only (e.g. `sam local start-api` against DynamoDB
 * Local), the standard `AWS_ENDPOINT_URL_DYNAMODB` environment variable, when
 * set to a non-empty value, is applied as an explicit client endpoint so the
 * client targets the local Data_Store. In every deployed Stage the variable is
 * unset, so the client resolves the real DynamoDB endpoint from the Lambda
 * execution environment exactly as before (Requirement 11.7).
 */
const dynamoEndpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const client = new DynamoDBClient(
  dynamoEndpoint ? { endpoint: dynamoEndpoint } : {}
);

/**
 * Marker error used to distinguish a Data_Store read failure from an increment
 * failure in the handler's top-level catch. Both `readCount` and
 * `incrementCount` throw generic errors, so the handler wraps each data call
 * and rethrows the underlying failure tagged with the operation it came from,
 * letting the catch map it to the correct 500 message (Requirements 1.6, 2.4,
 * 3.3, 5.3).
 */
class DataStoreError extends Error {
  constructor(
    readonly operation: "READ" | "INCREMENT",
    options?: { cause?: unknown }
  ) {
    super(operation, options);
    this.name = "DataStoreError";
  }
}

/**
 * Map a {@link ValidationError} to its HTTP 400 error message.
 *
 * The messages match the design's Error Handling table exactly (Requirement
 * 7.1–7.4, 7.6).
 */
function validationMessage(error: ValidationError): string {
  switch (error.kind) {
    case "INVALID_JSON":
      return "Request body is not valid JSON";
    case "BODY_TOO_LARGE":
      return "Request body exceeds the maximum allowed size";
    case "PAGE_ID_EMPTY":
      return "pageId must not be empty";
    case "PAGE_ID_TOO_LONG":
      return "pageId exceeds the maximum length of 128 code points";
    case "PAGE_ID_DISALLOWED_CHARS":
      return "pageId contains disallowed characters";
  }
}

/**
 * Shape a successful counter result into the 200 response body.
 */
function toResponseBody(result: CounterResult): CounterResponseBody {
  return { count: result.count, updatedAt: result.updatedAt };
}

/**
 * Emit exactly one Structured_Log for a server-side failure (Requirements 8.4,
 * 8.5, 8.6).
 *
 * Writes a single-line JSON object to standard error describing the operation
 * context and the underlying error's `name`/`message`/`stack`. For a
 * {@link DataStoreError} the underlying failure is `error.cause` (the original
 * SDK error preserved by the READ/INCREMENT wrappers); for any other unexpected
 * error the error itself is the underlying failure. This never records
 * request-supplied content and never alters the client-facing response body.
 */
function logServerFailure(
  operation: "READ" | "INCREMENT" | "UNEXPECTED",
  underlying: unknown
): void {
  const err = underlying instanceof Error ? underlying : undefined;
  console.error(
    JSON.stringify({
      level: "error",
      operation,
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    })
  );
}

/**
 * Resolve, validate, and (on success) return the target {@link CounterKey}, or
 * a 400 error response when validation fails.
 *
 * Enforces the fail-closed validation ordering (Requirement 7): the caller has
 * already handled body-size and JSON parsing; this step resolves the target
 * from the query string and parsed body, then validates the resolved Page_Id —
 * all before any Data_Store call.
 */
function resolveAndValidateKey(
  event: APIGatewayProxyEventV2,
  parsedBody: unknown,
  allowOrigin: string
): { key: CounterKey } | { response: APIGatewayProxyStructuredResultV2 } {
  // API Gateway v2 types query values as `string | undefined`; `resolveTarget`
  // (via its `nonEmptyString` guard) already tolerates missing/undefined values,
  // so narrow the map to the expected shape at this boundary.
  const queryParams = event.queryStringParameters as
    | Record<string, string>
    | undefined;
  const target = resolveTarget(queryParams, parsedBody);
  const validationError = validatePageId(target.pageId);
  if (validationError !== null) {
    return {
      response: buildErrorResponse(
        400,
        validationMessage(validationError),
        allowOrigin
      ),
    };
  }
  return { key: deriveCounterKey(target.pageId) };
}

/**
 * The Lambda handler for the Visitor Counter API.
 *
 * Resolves CORS, classifies the HTTP method, and routes:
 * - Unsupported method -> 405 (Requirement 8.1). OPTIONS preflight is answered
 *   by the API Gateway HTTP API at the edge and never reaches the Handler, so
 *   it classifies as OTHER here (Requirements 6.3, 6.4).
 * - GET -> read the count (Requirements 2.2, 2.3, 5.2).
 * - POST -> atomically increment the count (Requirements 1.2, 1.3).
 *
 * All routing runs inside a single top-level try/catch that maps Data_Store
 * read failures to 500 "Count could not be read", increment failures to 500
 * "Increment could not be recorded", and any other unexpected error to 500
 * "Request could not be processed" — always with CORS headers attached
 * (Requirements 1.6, 3.3, 8.2).
 */
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyStructuredResultV2> => {
  const allowOrigin = resolveAllowOrigin(process.env);

  try {
    const tableName = process.env.TABLE_NAME ?? "";
    const method = classifyMethod(event.requestContext.http.method);

    if (method === "OTHER") {
      return buildErrorResponse(405, "Method not supported", allowOrigin);
    }

    if (method === "GET") {
      // GET carries no body: resolve/validate the target, then read.
      const resolved = resolveAndValidateKey(event, undefined, allowOrigin);
      if ("response" in resolved) {
        return resolved.response;
      }

      const result = await readCount(client, tableName, resolved.key).catch(
        (cause) => {
          throw new DataStoreError("READ", { cause });
        }
      );
      return buildJsonResponse(200, toResponseBody(result), allowOrigin);
    }

    // method === "POST": fail-closed ordering — body size + JSON parse first,
    // then target resolution, then Page_Id validation, before any write.
    const parseResult = parseBody(event.body, event.isBase64Encoded ?? false);
    if ("error" in parseResult) {
      return buildErrorResponse(
        400,
        validationMessage(parseResult.error),
        allowOrigin
      );
    }

    const resolved = resolveAndValidateKey(
      event,
      parseResult.parsed,
      allowOrigin
    );
    if ("response" in resolved) {
      return resolved.response;
    }

    const now = new Date().toISOString();
    const result = await incrementCount(
      client,
      tableName,
      resolved.key,
      now
    ).catch((cause) => {
      throw new DataStoreError("INCREMENT", { cause });
    });
    return buildJsonResponse(200, toResponseBody(result), allowOrigin);
  } catch (error) {
    if (error instanceof DataStoreError) {
      logServerFailure(error.operation, error.cause);
      if (error.operation === "READ") {
        return buildErrorResponse(500, "Count could not be read", allowOrigin);
      }
      return buildErrorResponse(
        500,
        "Increment could not be recorded",
        allowOrigin
      );
    }
    logServerFailure("UNEXPECTED", error);
    return buildErrorResponse(
      500,
      "Request could not be processed",
      allowOrigin
    );
  }
};
