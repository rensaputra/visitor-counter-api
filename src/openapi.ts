/**
 * OpenAPI contract schemas for the Visitor Counter API.
 *
 * These are the *contract-shaped* schemas: they describe the request and
 * response bodies and parameters the API exposes over HTTP, as opposed to the
 * *validation-shaped* schemas in {@link ./input} (which validate a bare Page_Id
 * string and a raw JSON body string). Keeping them separate is deliberate — the
 * validation schemas answer "is this input acceptable?", while these answer
 * "what is the published shape of a request/response?".
 *
 * Both are kept in agreement by reusing the same validation constants
 * ({@link MAX_PAGE_ID_CODE_POINTS}, {@link PERMITTED_PAGE_ID},
 * {@link MAX_BODY_BYTES}) from the input module, so the documented constraints
 * can never silently drift from the enforced ones.
 *
 * This module has no runtime side effects and is not part of the Lambda bundle;
 * it is consumed only by the OpenAPI generation script.
 */

import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

import {
  MAX_PAGE_ID_CODE_POINTS,
  PERMITTED_PAGE_ID,
  MAX_BODY_BYTES,
} from "./input";

// Augment Zod with the `.openapi()` method. Must run before any schema below
// calls `.openapi()`. Safe to call once at module load.
extendZodWithOpenApi(z);

/**
 * The `pageId` field / `page` query value: a Page_Id string.
 *
 * The `maxLength` reflects {@link MAX_PAGE_ID_CODE_POINTS}. Note that OpenAPI /
 * JSON Schema `maxLength` counts UTF-16 code units, whereas the API enforces
 * the limit in Unicode code points; the description records this so consumers
 * understand the precise rule. The `pattern` mirrors {@link PERMITTED_PAGE_ID}.
 */
const pageIdField = z
  .string()
  .min(1)
  .max(MAX_PAGE_ID_CODE_POINTS)
  .regex(PERMITTED_PAGE_ID)
  .openapi({
    description:
      "Page identifier. Allowed characters: ASCII letters, digits, '-', " +
      "'_', '.', '/'. Maximum length is " +
      `${MAX_PAGE_ID_CODE_POINTS} Unicode code points (the server counts ` +
      "code points, not UTF-16 units).",
    example: "blog/hello-world",
  });

/**
 * The optional `page` query-string parameter used to select a counter.
 *
 * When absent or empty, the request targets the Global_Counter. When present
 * and non-empty, it takes precedence over any `pageId` body field.
 */
export const PageQueryParam = pageIdField.optional().openapi({
  param: {
    name: "page",
    in: "query",
    required: false,
    description:
      "Selects the counter to operate on. Takes precedence over the request " +
      "body `pageId`. Omit (or leave empty) to target the global counter.",
  },
});

/**
 * The POST request body. All fields optional: an empty body targets the
 * Global_Counter. A non-empty `pageId` selects a page counter, but only when no
 * non-empty `page` query parameter is supplied.
 *
 * The whole decoded body is capped at {@link MAX_BODY_BYTES} bytes server-side
 * before parsing; that byte-size limit is documented on the request body media
 * type in the path definition rather than as a schema keyword, since it applies
 * to the raw wire payload rather than a single field.
 */
export const CounterRequestBody = z
  .object({
    pageId: pageIdField.optional().openapi({
      description:
        "Page identifier to operate on. Ignored when a non-empty `page` " +
        "query parameter is present. Omit to target the global counter.",
    }),
  })
  .openapi("CounterRequest");

/**
 * The success (HTTP 200) response body for both read (GET) and increment
 * (POST). Mirrors the `CounterResponseBody` interface in {@link ./types}.
 */
export const CounterResponse = z
  .object({
    count: z.number().int().nonnegative().openapi({
      description: "Current visit count for the targeted counter.",
      example: 42,
    }),
    updatedAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({
        description:
          "ISO 8601 timestamp of the last increment, or null if the counter " +
          "has never been incremented.",
        example: "2026-09-28T12:34:56.000Z",
      }),
  })
  .openapi("CounterResponse");

/**
 * The error response body for all non-2xx responses (400/405/500). Mirrors the
 * `ErrorResponseBody` interface in {@link ./types}.
 */
export const ErrorResponse = z
  .object({
    error: z.string().openapi({
      description: "Human-readable description of the failure.",
      example: "pageId contains disallowed characters",
    }),
  })
  .openapi("ErrorResponse");

/**
 * The request query-string object shared by GET and POST: a single optional
 * `page` parameter. Exported as a ready-made object schema so the generation
 * script does not need its own Zod instance to wrap the parameter.
 */
export const QueryParams = z.object({ page: PageQueryParam });

/**
 * The maximum decoded request-body size, re-exported so the generation script
 * can document it on the POST request body without importing the input module
 * directly.
 */
export const MAX_REQUEST_BODY_BYTES = MAX_BODY_BYTES;
