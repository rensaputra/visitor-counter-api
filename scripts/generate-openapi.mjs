/**
 * Generates the OpenAPI 3.1 document for the Visitor Counter API and writes it
 * to `openapi.json` at the project root.
 *
 * The contract schemas live in `src/openapi.ts` (TypeScript). Rather than add a
 * TS loader, this script reuses the project's existing esbuild dependency to
 * bundle that module to a temporary ESM file, dynamically imports it, builds
 * the OpenAPI document from the registered paths, and writes the result.
 *
 * Run via `npm run openapi`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT_PATH = join(PROJECT_ROOT, "openapi.json");

/**
 * Bundle `src/openapi.ts` (and its imports, e.g. `src/input.ts`) into a single
 * temporary ESM module and dynamically import it, returning the exported
 * contract schemas. Zod and the zod-to-openapi runtime are kept external so the
 * bundled module shares the same instances this script uses.
 */
async function loadContractSchemas() {
  // Emit the bundle inside the project tree (not the OS temp dir) so the
  // externalized `zod` / `@asteasolutions/zod-to-openapi` imports resolve
  // against the project's node_modules — and share the same module instances
  // this script uses, which the generator requires.
  const dir = await mkdtemp(join(PROJECT_ROOT, ".openapi-tmp-"));
  const outfile = join(dir, "openapi.bundle.mjs");
  try {
    await build({
      entryPoints: [join(PROJECT_ROOT, "src", "openapi.ts")],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["zod", "@asteasolutions/zod-to-openapi"],
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  const {
    QueryParams,
    CounterRequestBody,
    CounterResponse,
    ErrorResponse,
    MAX_REQUEST_BODY_BYTES,
  } = await loadContractSchemas();

  const registry = new OpenAPIRegistry();

  // Register named components so paths reference them via $ref.
  registry.register("CounterRequest", CounterRequestBody);
  registry.register("CounterResponse", CounterResponse);
  registry.register("ErrorResponse", ErrorResponse);

  /** The shared error responses attached to every operation. */
  const errorResponses = {
    400: {
      description: "Validation failed (bad JSON, oversized body, or invalid pageId).",
      content: { "application/json": { schema: ErrorResponse } },
    },
    405: {
      description: "HTTP method not supported for this resource.",
      content: { "application/json": { schema: ErrorResponse } },
    },
    500: {
      description: "The request could not be processed server-side.",
      content: { "application/json": { schema: ErrorResponse } },
    },
  };

  const okResponse = {
    200: {
      description: "Current visit count for the targeted counter.",
      content: { "application/json": { schema: CounterResponse } },
    },
  };

  registry.registerPath({
    method: "get",
    path: "/",
    operationId: "readCount",
    // Public endpoint: no authentication. Declared explicitly so the contract
    // states "no auth" rather than leaving it unspecified.
    security: [],
    summary: "Read the current visit count",
    description:
      "Returns the current count for the counter selected by the `page` " +
      "query parameter, or the global counter when `page` is omitted. Does " +
      "not modify any counter.",
    request: {
      query: QueryParams,
    },
    responses: { ...okResponse, ...errorResponses },
  });

  registry.registerPath({
    method: "post",
    path: "/",
    operationId: "incrementCount",
    // Public endpoint: no authentication. See note on the GET operation.
    security: [],
    summary: "Increment and read the visit count",
    description:
      "Atomically increments the counter selected by the `page` query " +
      "parameter or the request body `pageId` (query wins), or the global " +
      "counter when neither is supplied, and returns the new count. The " +
      `decoded request body must not exceed ${MAX_REQUEST_BODY_BYTES} bytes.`,
    request: {
      query: QueryParams,
      body: {
        required: false,
        content: {
          "application/json": { schema: CounterRequestBody },
        },
      },
    },
    responses: { ...okResponse, ...errorResponses },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Visitor Counter API",
      version: "1.0.0",
      description:
        "Serverless visitor counter. GET reads a count; POST atomically " +
        "increments and returns it. Counters are selected by page or default " +
        "to a global counter.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [
      {
        url: "https://{apiId}.execute-api.{region}.amazonaws.com/{stage}",
        description: "Deployed HTTP API stage",
        variables: {
          apiId: { default: "your-api-id" },
          region: { default: "ap-southeast-2" },
          stage: { default: "dev" },
        },
      },
    ],
  });

  await writeFile(OUTPUT_PATH, JSON.stringify(document, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
