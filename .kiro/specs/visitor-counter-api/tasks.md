# Implementation Plan: Visitor Counter API

## Overview

This plan covers the AWS SAM migration of the Visitor_Counter_API. The base implementation (the pure logic layers, the DynamoDB-backed counter service, the handler, and the Jest suite with the coverage gate) was completed in a prior iteration and is summarized as done below. The migration moves packaging and infrastructure from a hand-rolled esbuild script to AWS SAM, and shifts CORS OPTIONS preflight handling from the Handler to the API Gateway HTTP API edge.

The migration work is the actionable, not-started portion. It:

- Simplifies the CORS module (removes `buildPreflightResponse`; preflight is gateway-owned).
- Simplifies the router (`Method` becomes `"GET" | "POST" | "OTHER"`; OPTIONS classifies as OTHER).
- Simplifies the handler (removes the OPTIONS→preflight branch; keeps GET/POST routing, validation ordering, and the try/catch envelope).
- Removes the old esbuild build pipeline (`scripts/build.mjs`, `src/build.test.ts`, and the obsolete npm `build`/`package` scripts).
- Adds `template.yaml` (HTTP API v2 with gateway-managed CORS/preflight, Lambda with esbuild BuildMethod on `nodejs24.x`, a stack-owned DynamoDB table, and a least-privilege `DynamoDBCrudPolicy`) and `samconfig.toml` (dev/prod config-envs).
- Verifies `sam validate --lint` and `sam build`, and confirms the Jest coverage gate still passes.

Property numbering follows the updated design: **Properties 1–17**. The old preflight property has been removed; Property 11 is now "every Handler response carries the resolved Allow_Origin header" and Property 17 is "method classification and unsupported-method rejection". Property-test comment tags in `src/*.test.ts` are renumbered to match during this migration.

Tasks marked with `*` are optional test sub-tasks. SAM verification (`sam validate --lint`, `sam build`) is a coding/CI concern and is NOT property-tested; there is no Docker-based integration test in the CI gate.

## Tasks

### Completed in prior iteration (base implementation)

- [x] 0. Base Visitor_Counter_API implementation (original tasks 1–13)
  - Project structure, tooling, and shared types in `src/types.ts` (`package.json`, `tsconfig.json`, `jest.config.js`).
  - CORS module `src/cors.ts` (`resolveAllowOrigin`, `corsHeaders`, and the now-obsolete `buildPreflightResponse`) with tests.
  - Response module `src/response.ts` (`buildJsonResponse`, `buildErrorResponse`) with the CORS-on-every-response property test.
  - Router `src/router.ts` (`classifyMethod`) with the method-classification property test.
  - Input module `src/input.ts` (target resolution, key derivation, `validatePageId`, `parseBody`) with target/validation property tests.
  - Counter service `src/counter.ts` (`readCount`, `incrementCount` atomic `UpdateItem`) with increment/read/concurrency property tests and failure-mapping examples.
  - Handler `src/index.ts` wiring all modules with validation ordering and a single try/catch envelope, plus integration/edge tests.
  - The esbuild build pipeline `scripts/build.mjs` with `src/build.test.ts` (superseded by this migration).
  - Jest coverage gate (≥95% statements, ≥90% branches). Suite passes at 99.29% statements / 95.19% branches.
  - _Requirements: 1–10 (as implemented prior to the SAM migration)_

### SAM migration (not started)

- [x] 1. Simplify the CORS module for gateway-owned preflight
  - [x] 1.1 Remove preflight construction from `src/cors.ts`
    - Delete `buildPreflightResponse` (and the now-unused `APIGatewayProxyStructuredResultV2` import and preflight-only constants such as `ALLOWED_METHODS`/`ALLOWED_HEADERS` if they become unused) from `src/cors.ts`
    - Keep `resolveAllowOrigin` and `corsHeaders` and their behavior unchanged; update the module doc comment to state that preflight is now owned by the HTTP API
    - _Requirements: 6.1, 6.2, 6.3_

  - [x] 1.2 Remove the obsolete preflight property test from `src/cors.test.ts`
    - Delete the old "Property 11: Preflight response shape" test block and the `buildPreflightResponse` import
    - Keep the Allow_Origin resolution property test intact
    - **Property 10: Allow_Origin resolution** (unchanged, still tagged Property 10)
    - _Requirements: 6.1, 6.2, 6.3_

- [x] 2. Simplify the router to drop OPTIONS as a handled case
  - [x] 2.1 Narrow the `Method` type and `classifyMethod`
    - Change the `Method` type in `src/types.ts` to `"GET" | "POST" | "OTHER"` and update its doc comment
    - Update `classifyMethod` in `src/router.ts` to remove the `OPTIONS` case so OPTIONS falls through to `OTHER`; update the doc comment noting OPTIONS preflight is answered by the HTTP API and does not reach the Handler
    - _Requirements: 8.1_

  - [x] 2.2 Update the router property test so OPTIONS classifies as OTHER
    - In `src/router.test.ts`, remove `OPTIONS` from the supported set/generators and add coverage asserting `classifyMethod("OPTIONS")` (and cased variants) returns `"OTHER"`
    - Renumber the property-test tag comments from Property 18 to **Property 17: Method classification and unsupported-method rejection**
    - **Property 17: Method classification and unsupported-method rejection**
    - **Validates: Requirements 8.1**

- [x] 3. Simplify the handler to remove the OPTIONS→preflight branch
  - [x] 3.1 Remove preflight routing from `src/index.ts`
    - Delete the `OPTIONS → buildPreflightResponse` routing branch and its import; keep GET → `readCount`, POST → `incrementCount`, and `OTHER → 405`
    - Keep the fail-closed validation ordering (body-size → JSON parse → target resolution → Page_Id validation) and the single top-level try/catch envelope (400/405/500 all via CORS-bearing responses) unchanged
    - _Requirements: 6.4, 8.1, 8.2_

  - [x] 3.2 Update handler tests for the removed preflight path
    - In `src/index.test.ts`, replace the preflight assertion in the CORS-on-every-response test with an OPTIONS→405 (OTHER) assertion, and remove any assertion expecting a 204 preflight from the Handler
    - Ensure the "every Handler response carries the resolved Allow_Origin header" coverage holds for GET/POST/OTHER/error responses; renumber its tag from the old Property 12 to **Property 11**
    - **Property 11: Every Handler response carries the resolved Allow_Origin header**
    - **Validates: Requirements 6.4, 8.1, 8.2**

- [x] 4. Remove the obsolete esbuild build pipeline
  - [x] 4.1 Delete the build script and its smoke test
    - Delete `scripts/build.mjs` and `src/build.test.ts`
    - _Requirements: 9 (superseded by SAM)_

  - [x] 4.2 Remove obsolete npm scripts from `package.json`
    - Remove the `build` (and any `package`) script from `package.json`; keep `test`, `test:coverage`, and `typecheck`
    - Remove `esbuild` from `devDependencies` only if it is no longer referenced by anything in the repo (SAM invokes its own esbuild during `sam build`); otherwise leave it
    - _Requirements: 9 (superseded by SAM)_

- [x] 5. Author the SAM template (`template.yaml`)
  - [x] 5.1 Define parameters and the HTTP API with gateway-managed CORS
    - Create `template.yaml` (`AWS::Serverless-2016-10-31`) with a `Stage` parameter (`dev`|`prod`) and an `AllowOrigin` parameter (default `*` for dev; no default so prod must supply it)
    - Define `AWS::Serverless::HttpApi` (payload format version 2.0) with gateway-managed `CorsConfiguration`: `AllowOrigins` from `AllowOrigin`, `AllowMethods` including `GET`, `POST`, `OPTIONS`, and `AllowHeaders` including `Content-Type`, so the gateway answers OPTIONS preflight at the edge without invoking the Handler
    - _Requirements: 11.1, 11.5_

  - [x] 5.2 Define the Lambda function with the esbuild BuildMethod and routes
    - Add `AWS::Serverless::Function` with `Runtime: nodejs24.x`, `Handler: index.handler`, `Environment.Variables` `TABLE_NAME` (per-Stage table name) and `ALLOW_ORIGIN` (from `AllowOrigin`)
    - Add `Metadata.BuildMethod: esbuild` with `Minify: true`, `Target: node24`, `Sourcemap: true`, `EntryPoints: ["index.ts"]`
    - Bind `HttpApi` events for the GET and POST routes to the Handler
    - _Requirements: 9.5, 11.1_

  - [x] 5.3 Define the stack-owned DynamoDB table and least-privilege IAM
    - Add a stack-owned table (`AWS::Serverless::SimpleTable` or `AWS::DynamoDB::Table`) with a `pageId` partition key and a per-Stage name (e.g. `visitor-counter-${Stage}`), lifecycle-managed by the stack; wire its name into the Handler's `TABLE_NAME`
    - Attach a `DynamoDBCrudPolicy` (or equivalent inline least-privilege policy) scoped to only this table
    - _Requirements: 11.2, 11.3, 11.4_

- [x] 6. Add multi-environment SAM configuration (`samconfig.toml`)
  - [x] 6.1 Define dev and prod config-envs
    - Create `samconfig.toml` with `dev` and `prod` config-envs, each a separate CloudFormation stack name in the same AWS account
    - Set per-env `parameter_overrides` for `Stage` and `AllowOrigin`; dev defaults `AllowOrigin=*`, prod requires an explicit `AllowOrigin`
    - _Requirements: 9.4, 11.5_

- [x] 7. Verify the SAM build and template
  - [x] 7.1 Validate and build the SAM app
    - Run `sam validate --lint` and confirm it passes (fix any template lint findings)
    - Run `sam build` and confirm it produces a self-contained, dependency-bundled Handler artifact and exits 0; confirm a failed build exits non-zero with no artifact
    - Document `sam local start-api` in the repo as a dev-only manual step (requires Docker; NOT part of CI, no Docker in CI)
    - _Requirements: 9.1, 9.2, 9.3, 11.6_

- [x] 8. Confirm the Jest coverage gate still passes after simplifications
  - [x] 8.1 Re-run the suite and restore coverage if needed
    - Run the full Jest suite with coverage; confirm ≥95% statements and ≥90% branches after the CORS/router/handler simplifications and the removal of `src/build.test.ts` and the preflight test
    - If coverage drops below either threshold, add or adjust targeted tests (e.g. OPTIONS→OTHER classification, OPTIONS→405 through the Handler) — do NOT lower the thresholds
    - _Requirements: 10.1, 10.4, 10.5, 10.6, 10.7_

- [x] 9. Final checkpoint - migration complete
  - Ensure all Jest tests pass, `sam validate --lint` passes, and the coverage gate (≥95% statements, ≥90% branches) is satisfied. Ask the user if questions arise.

### Error observability (structured logging on 500s)

- [x] 10. Instrument server-side failures with structured JSON logging
  - [x] 10.1 Preserve the underlying error when wrapping into `DataStoreError`
    - In `src/index.ts`, update the two `.catch(() => { throw new DataStoreError(...) })` wrappers (READ and INCREMENT) to capture the original error, e.g. `.catch((cause) => { throw new DataStoreError("READ", { cause }); })`, and extend the `DataStoreError` constructor to accept and store the `cause` (via `super(message, { cause })` or an own field) so the underlying SDK error survives to the top-level catch
    - Keep the existing thrown-operation semantics (READ vs INCREMENT) unchanged
    - _Requirements: 8.4_

  - [x] 10.2 Emit a single Structured_Log for every 500 path in the top-level catch
    - In the top-level `catch` of `src/index.ts`, before returning each 500 response, emit exactly one `console.error(JSON.stringify({ level: "error", operation, name, message, stack }))` where `operation` is `"READ"`, `"INCREMENT"`, or `"UNEXPECTED"` and `name`/`message`/`stack` come from the underlying error (`error.cause` for a `DataStoreError`, otherwise `error` itself)
    - Do NOT change any client-facing response body: 500 bodies stay the fixed generic messages, and no internal detail is added to the response; do NOT log on the 400/405 paths (they return before the catch)
    - _Requirements: 8.4, 8.5, 8.6_

  - [x] 10.3 Add example tests for the logging behavior
    - In `src/index.test.ts`, add example tests that spy on `console.error` (e.g. `jest.spyOn(console, "error").mockImplementation(() => {})`, restored in `afterEach`) and assert: (a) each 500 path (mocked READ failure, mocked INCREMENT failure, and the unexpected-error path) logs exactly once with a JSON string whose parsed object has the expected `operation` and the underlying error's `name`/`message`/`stack`; (b) the response body for those 500s is still the generic message with no internal detail; (c) a 400 (invalid input) and a 405 (unsupported method) produce zero `console.error` calls
    - Confirm the suite still passes and the coverage gate (≥95% statements, ≥90% branches) holds via `npm run test:coverage`
    - _Requirements: 8.4, 8.5, 8.6, 10.1, 10.6, 10.7_

  - [x] 10.4 Re-verify build and template after instrumentation
    - Run `sam validate --lint` and `sam build` to confirm the code change still bundles cleanly and exits 0 (no template change expected; logging uses the runtime's built-in `console`, no new dependency)
    - _Requirements: 9.1, 9.3_

## Notes

- This plan is the AWS SAM migration; the base implementation (original tasks 1–13) is complete and collapsed into the "Completed in prior iteration" summary (task 0), which is intentionally excluded from the dependency graph as a satisfied prerequisite.
- Property numbering follows the updated design: **Properties 1–17**. The old preflight property is removed; Property 11 is now "every Handler response carries the resolved Allow_Origin header" and Property 17 is "method classification and unsupported-method rejection". Migration tasks renumber the matching `// Feature: visitor-counter-api, Property {n}: ...` tags in `src/router.test.ts` (18→17) and `src/index.test.ts` (12→11), and remove the old Property 11 preflight test from `src/cors.test.ts`.
- Tasks marked with `*` are optional test sub-tasks and can be skipped for a faster path, but they keep the property tests aligned with the simplified modules.
- SAM `template.yaml` owns build, HTTP API (including OPTIONS preflight), the DynamoDB table, IAM, environment configuration, and dev/prod deploys, replacing the removed `scripts/build.mjs`/`dist` archive pipeline.
- `sam validate --lint` and `sam build` are verified via SAM tooling (coding/CI), not property tests. `sam local start-api` is documented as a dev-only manual capability and is not part of CI; CI must not require Docker.
- Property tests use fast-check with ≥100 iterations and are tagged `// Feature: visitor-counter-api, Property {number}: {property text}`; Data_Store interactions in tests are simulated with aws-sdk-client-mock.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.1", "4.2", "5.2", "6.1"] },
    { "id": 2, "tasks": ["3.2", "5.3"] },
    { "id": 3, "tasks": ["7.1", "8.1"] },
    { "id": 4, "tasks": ["10.1"] },
    { "id": 5, "tasks": ["10.2"] },
    { "id": 6, "tasks": ["10.3", "10.4"] }
  ]
}
```
