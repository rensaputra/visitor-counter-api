# Requirements Document

## Introduction

The Visitor Counter API is a serverless HTTP service that tracks page visit counts on AWS. It is built with TypeScript and deployed as an AWS Lambda function behind an API Gateway HTTP API, with counts persisted in Amazon DynamoDB. The service supports per-page counters and a site-wide global counter, distinguishes read operations from increment operations by HTTP method, performs atomic increments to remain accurate under concurrency, and handles uninitialized pages gracefully. The service includes configurable CORS support with API Gateway–managed preflight handling, strict input sanitization, infrastructure and packaging managed by AWS SAM (build, dev-only local testing, and multi-environment deploy), and a comprehensive Jest test suite with high coverage.

## Glossary

- **Visitor_Counter_API**: The overall serverless HTTP service that tracks and reports visit counts.
- **Handler**: The AWS Lambda function that receives API Gateway HTTP API events and returns HTTP responses.
- **Data_Store**: The Amazon DynamoDB table that persists counter records.
- **Counter_Record**: A stored item representing a single page's count, containing a page identifier, a count value, and a last-updated timestamp.
- **Page_Id**: A string identifier for the page whose visits are being counted. Supplied via the `page` query string parameter (GET/POST) or the `pageId` JSON body field (POST). A valid Page_Id is between 1 and 128 characters inclusive and contains only characters from the Permitted_Character_Set. Page_Id values are compared using exact, case-sensitive string comparison.
- **Permitted_Character_Set**: The set of characters allowed in a Page_Id, consisting of ASCII letters (a-z, A-Z), ASCII digits (0-9), hyphen (`-`), underscore (`_`), period (`.`), and forward slash (`/`).
- **Global_Counter**: The Counter_Record used when no Page_Id is supplied, representing a site-wide count.
- **Count**: The non-negative integer number of recorded visits for a given Page_Id.
- **Updated_At**: The ISO 8601 timestamp of the most recent increment for a Counter_Record, or null when never incremented.
- **Increment_Operation**: A POST request that atomically increases a Counter_Record's Count by one and returns the resulting Count.
- **Read_Operation**: A GET request that returns a Counter_Record's Count without modifying it.
- **Preflight_Request**: An HTTP OPTIONS request sent by a browser to check CORS permissions before the actual request.
- **Allow_Origin**: The CORS allowed-origin value, supplied as a per-Stage deploy-time parameter that feeds BOTH the HTTP_API CORS configuration and the Handler's `ALLOW_ORIGIN` environment variable. Defaults to `*` for the `dev` Stage and has no default for the `prod` Stage (must be supplied at deploy).
- **SAM_Template**: The AWS SAM `template.yaml` that declares the HTTP_API, the Handler, the Data_Store, IAM policies, environment configuration, and deploy parameters.
- **SAM_Build**: The `sam build` process that packages the Handler into a self-contained deployable artifact using the SAM esbuild BuildMethod.
- **HTTP_API**: The API Gateway HTTP API (payload format version 2.0) that fronts the Handler, owns CORS configuration, and answers OPTIONS Preflight_Requests without invoking the Handler.
- **Stage**: A deployment environment, one of `dev` or `prod`, each deployed as a separate CloudFormation stack in the same AWS account and parameterized via a Stage parameter and `samconfig.toml`.
- **Test_Suite**: The Jest (ts-jest) test collection, using aws-sdk-client-mock for AWS interactions.
- **Structured_Log**: A single-line JSON object the Handler writes to standard error (captured by CloudWatch Logs) describing a server-side failure, containing at least a severity level, the operation context (`READ`, `INCREMENT`, or `UNEXPECTED`), and the underlying error's name, message, and stack. It never contains request-supplied content.

## Requirements

### Requirement 1: Increment Visitor Count

**User Story:** As a website owner, I want a POST request to increment and return the visit count, so that each visit is recorded and the current total is available in one call.

#### Acceptance Criteria

1. WHEN a POST request is received with a Page_Id that is between 1 and 128 characters and contains only permitted characters, THE Visitor_Counter_API SHALL atomically increase the corresponding Counter_Record's Count by exactly one.
2. WHEN a POST request is received without a Page_Id, THE Visitor_Counter_API SHALL atomically increase the Global_Counter's Count by exactly one.
3. WHEN an Increment_Operation completes successfully, THE Visitor_Counter_API SHALL respond with HTTP status 200 and a JSON body containing a `count` field holding the resulting post-increment Count as a non-negative integer and an `updatedAt` field holding the ISO 8601 Updated_At timestamp of that increment.
4. WHEN an Increment_Operation completes successfully, THE Visitor_Counter_API SHALL set the affected Counter_Record's Updated_At to the ISO 8601 timestamp of that increment.
5. WHEN a POST request targets a Page_Id that has no existing Counter_Record, THE Visitor_Counter_API SHALL create the Counter_Record with a Count of 1 and set its Updated_At to the ISO 8601 timestamp of that increment.
6. IF the atomic Data_Store update for an Increment_Operation fails, THEN THE Visitor_Counter_API SHALL leave the targeted Counter_Record's Count and Updated_At unchanged and respond with HTTP status 500 and a JSON body containing an error message indicating that the increment could not be recorded.

### Requirement 2: Read Visitor Count

**User Story:** As a website owner, I want a GET request to return the current count without changing it, so that I can display the count without recording a visit.

#### Acceptance Criteria

1. WHEN a GET request is received with a valid Page_Id, THE Visitor_Counter_API SHALL return the corresponding Counter_Record's Count as a non-negative integer without modifying the Counter_Record's Count or Updated_At.
2. WHEN a GET request is received without a Page_Id, THE Visitor_Counter_API SHALL return the Global_Counter's Count as a non-negative integer without modifying the Global_Counter's Count or Updated_At.
3. WHEN a Read_Operation completes successfully, THE Visitor_Counter_API SHALL respond with HTTP status 200 and a JSON body containing a `count` field holding the Count as a non-negative integer and an `updatedAt` field holding either the Updated_At as an ISO 8601 timestamp, or null when the Counter_Record has never been incremented.
4. IF the Data_Store read for a Read_Operation fails, THEN THE Visitor_Counter_API SHALL leave the targeted Counter_Record's Count and Updated_At unchanged and respond with HTTP status 500 and a JSON body containing an error message indicating the count could not be read.

### Requirement 3: Atomic Increments Under Concurrency

**User Story:** As a website owner, I want increments to be atomic, so that concurrent visits are counted accurately without lost updates.

#### Acceptance Criteria

1. WHEN N Increment_Operations (where N is an integer of 2 or more) target the same Page_Id concurrently, meaning the operations overlap in-flight such that one begins before another completes, and all N operations complete successfully, THE Visitor_Counter_API SHALL apply each increment exactly once so that the Counter_Record's final Count equals its initial Count plus N regardless of the order in which the operations are applied, with no lost updates.
2. THE Visitor_Counter_API SHALL perform each Increment_Operation as a single atomic update against the Data_Store.
3. IF an atomic update for an Increment_Operation cannot complete because of a concurrent update to the same Counter_Record, THEN THE Visitor_Counter_API SHALL leave the targeted Counter_Record's Count and Updated_At unchanged and respond with HTTP status 500 and a JSON body containing an error message indicating that the increment could not be recorded, so that the increment is never silently lost.

### Requirement 4: Multi-Page and Multi-Domain Support

**User Story:** As a website owner, I want to track individual pages or a site-wide total, so that I can measure traffic at the granularity I choose.

#### Acceptance Criteria

1. WHEN a GET or POST request supplies a `page` query string parameter whose value is a non-empty string, THE Visitor_Counter_API SHALL use that parameter value as the Page_Id.
2. WHEN a POST request supplies no non-empty `page` query string parameter and supplies a `pageId` field whose value is a non-empty string in a JSON body, THE Visitor_Counter_API SHALL use that field value as the Page_Id.
3. IF a single request supplies both a non-empty `page` query string parameter and a non-empty `pageId` body field, THEN THE Visitor_Counter_API SHALL use the `page` query string parameter value as the Page_Id and SHALL ignore the `pageId` body field.
4. WHEN a request supplies neither a non-empty `page` query string parameter nor a non-empty `pageId` body field, including when both are absent, both are empty strings, or one is absent and the other is an empty string, THE Visitor_Counter_API SHALL operate on the Global_Counter.
5. WHEN two requests supply Page_Id values that are not identical under exact, case-sensitive string comparison, THE Visitor_Counter_API SHALL store each value as a separate Counter_Record in the Data_Store.
6. WHEN two requests supply Page_Id values that are identical under exact, case-sensitive string comparison, THE Visitor_Counter_API SHALL operate on the same Counter_Record in the Data_Store.

### Requirement 5: Graceful Initialization

**User Story:** As a website owner, I want reading an uninitialized page to succeed with a zero count, so that new pages display correctly instead of returning an error.

#### Acceptance Criteria

1. WHEN a GET request targets a Page_Id and a successful Data_Store lookup confirms that no Counter_Record exists for that Page_Id, THE Visitor_Counter_API SHALL respond with HTTP status 200 and a JSON body of `{ "count": 0, "updatedAt": null }` without creating a Counter_Record for that Page_Id.
2. WHEN a GET request targets the Global_Counter and a successful Data_Store lookup confirms that no Global_Counter Counter_Record exists, THE Visitor_Counter_API SHALL respond with HTTP status 200 and a JSON body of `{ "count": 0, "updatedAt": null }` without creating a Counter_Record for the Global_Counter.
3. IF a GET request targets a Page_Id or the Global_Counter and the Data_Store lookup fails rather than confirming the Counter_Record's absence, THEN THE Visitor_Counter_API SHALL respond with HTTP status 500 and a JSON body containing an error message indicating the count could not be read, without creating a Counter_Record for that Page_Id or the Global_Counter.

### Requirement 6: CORS Support with Gateway-Managed Preflight

**User Story:** As a front-end developer, I want configurable CORS support with the API Gateway HTTP API answering preflight requests, so that browsers can call the API from permitted origins without the Handler being invoked for preflight.

#### Acceptance Criteria

1. WHERE the `ALLOW_ORIGIN` environment variable is set to a non-empty value, THE Handler SHALL use that value as the Allow_Origin in the CORS headers it attaches to its own responses.
2. WHERE the `ALLOW_ORIGIN` environment variable is not set or is empty, THE Handler SHALL use `*` as the Allow_Origin in the CORS headers it attaches to its own responses.
3. WHEN a Preflight_Request is received, THE HTTP_API SHALL respond with HTTP status 204, allowed origin equal to the configured Allow_Origin, allowed methods including GET, POST, and OPTIONS, and allowed request headers including Content-Type, without invoking the Handler.
4. WHEN the Handler returns any HTTP response, regardless of the response status code, THE Handler SHALL include in that response a CORS allowed-origin header whose value equals the Allow_Origin determined by criteria 1 and 2.
5. THE SAM_Template SHALL configure the HTTP_API CORS allowed origin from the same per-Stage deploy-time parameter that sets the Handler's `ALLOW_ORIGIN` environment variable, so that the HTTP_API and the Handler agree on the Allow_Origin.

### Requirement 7: Input Sanitization

**User Story:** As an operator, I want malformed and invalid input rejected cleanly, so that the service stays reliable and secure.

#### Acceptance Criteria

1. IF a POST request body is present but is not valid JSON, THEN THE Visitor_Counter_API SHALL respond with HTTP status 400 and a JSON body containing an error message indicating that the request body is not valid JSON, without modifying any Counter_Record.
2. IF a supplied Page_Id has a length greater than 128 Unicode code points, THEN THE Visitor_Counter_API SHALL respond with HTTP status 400 and a JSON body containing an error message indicating that the Page_Id exceeds the maximum length of 128 code points, without modifying any Counter_Record.
3. IF a supplied Page_Id contains any character outside the permitted character set of ASCII letters (a-z, A-Z), ASCII digits (0-9), hyphen, underscore, period, and forward slash, THEN THE Visitor_Counter_API SHALL respond with HTTP status 400 and a JSON body containing an error message indicating that the Page_Id contains disallowed characters, without modifying any Counter_Record.
4. IF a supplied Page_Id is an empty string of length 0 code points, THEN THE Visitor_Counter_API SHALL respond with HTTP status 400 and a JSON body containing an error message indicating that the Page_Id must not be empty, without modifying any Counter_Record.
5. WHEN a request supplies a Page_Id that has a length between 1 and 128 Unicode code points inclusive and contains only characters from the permitted character set of ASCII letters (a-z, A-Z), ASCII digits (0-9), hyphen, underscore, period, and forward slash, THE Visitor_Counter_API SHALL accept the Page_Id and process the request.
6. IF a POST request body has a length greater than 8192 bytes, THEN THE Visitor_Counter_API SHALL respond with HTTP status 400 and a JSON body containing an error message indicating that the request body exceeds the maximum allowed size, without modifying any Counter_Record.

### Requirement 8: HTTP Method Handling

**User Story:** As a front-end developer, I want unsupported methods handled clearly, so that clients receive predictable responses.

#### Acceptance Criteria

1. WHEN a request reaching the Handler uses an HTTP method whose case-insensitive value is not GET or POST, THE Visitor_Counter_API SHALL respond with HTTP status 405 and a JSON error message indicating the method is not supported, without modifying any Counter_Record; OPTIONS Preflight_Requests are answered by the HTTP_API and do not reach the Handler.
2. IF an unexpected error occurs while processing a request, THEN THE Visitor_Counter_API SHALL respond with HTTP status 500 and a JSON error message indicating the request could not be processed.
3. IF an unexpected error occurs while processing an Increment_Operation, THEN THE Visitor_Counter_API SHALL leave the targeted Counter_Record's Count and Updated_At unchanged.
4. WHEN the Handler responds with HTTP status 500 for any reason (Data_Store read failure, Data_Store increment failure, or an unexpected error), THE Handler SHALL emit exactly one Structured_Log to standard error that records the operation context and the underlying error's name, message, and stack, so that the exact cause is observable in CloudWatch Logs.
5. WHERE the Handler emits a Structured_Log for a 500 response, THE Handler SHALL keep the client-facing JSON response body limited to the generic error message defined for that condition and SHALL NOT include the underlying error's name, message, stack, or any request-supplied content in the response body.
6. WHEN the Handler responds with an HTTP status of 400 or 405, THE Handler SHALL NOT emit a Structured_Log, since those are expected client-side outcomes rather than server-side failures.

### Requirement 9: SAM Build, Package, and Deploy

**User Story:** As an operator, I want the Handler built, packaged, and deployed with AWS SAM, so that I can ship a self-contained Lambda across environments without dependency drift.

#### Acceptance Criteria

1. WHEN SAM_Build runs and completes successfully, THE SAM_Build SHALL produce a self-contained deployable Handler artifact via the SAM esbuild BuildMethod with all runtime dependencies bundled, and terminate with a success exit status (exit code 0).
2. IF SAM_Build fails to produce the Handler artifact, THEN THE SAM_Build SHALL terminate with a non-zero failure exit status and SHALL NOT produce a deployable artifact.
3. WHEN the SAM_Template is validated with `sam validate --lint`, THE SAM_Template SHALL validate successfully.
4. THE Visitor_Counter_API SHALL be deployable for each Stage (`dev` and `prod`) as a separate CloudFormation stack in the same AWS account via `sam deploy` using per-Stage configuration.
5. THE Handler SHALL target the `nodejs24.x` Lambda runtime.

### Requirement 10: Test Coverage

**User Story:** As a maintainer, I want a comprehensive automated test suite, so that behavior is verified and regressions are caught.

#### Acceptance Criteria

1. THE Test_Suite SHALL assert, for increment behavior, an HTTP 200 status and a JSON response body containing the `count` and `updatedAt` fields; for read behavior, an HTTP 200 status and a JSON response body containing the `count` and `updatedAt` fields; for graceful initialization, an HTTP 200 status and a JSON response body of `{ "count": 0, "updatedAt": null }`; for CORS handling, the presence of the Allow_Origin header on the Handler's own responses; and for input sanitization, an HTTP 400 status and a JSON response body containing an error message.
2. WHEN the Test_Suite runs, THE Test_Suite SHALL simulate both successful and failing Data_Store interactions using aws-sdk-client-mock rather than a live Data_Store.
3. WHEN a Data_Store failure is simulated for an Increment_Operation, THE Test_Suite SHALL assert an HTTP 500 status and a JSON response body containing an error message.
4. THE Test_Suite SHALL assert an HTTP 405 status and a JSON response body containing an error message for a request using an unsupported HTTP method.
5. THE Test_Suite SHALL assert an HTTP 400 status and a JSON response body containing an error message for a request with invalid input.
6. WHEN test coverage is measured over the Visitor_Counter_API source under test, THE Test_Suite SHALL achieve at least 95 percent statement coverage and at least 90 percent branch coverage.
7. IF measured coverage is below 95 percent statement coverage or below 90 percent branch coverage, THEN THE Test_Suite SHALL terminate with a non-zero failure exit status so that the coverage gate fails in continuous integration.

### Requirement 11: Infrastructure and Environment Configuration

**User Story:** As an operator, I want the API's infrastructure and environment configuration declared in the SAM template, so that each environment is reproducible, isolated, and least-privilege.

#### Acceptance Criteria

1. THE SAM_Template SHALL define the HTTP_API with payload format version 2.0, GET and POST routes to the Handler, gateway-managed CORS configuration, and gateway-managed OPTIONS Preflight_Request handling.
2. THE SAM_Template SHALL define and own the DynamoDB Data_Store with a `pageId` partition key, lifecycle-managed by the CloudFormation stack.
3. THE SAM_Template SHALL derive the Data_Store table name per Stage so that the `dev` and `prod` Stages use separate tables, and SHALL inject the resolved table name into the Handler via the `TABLE_NAME` environment variable.
4. THE SAM_Template SHALL grant the Handler a least-privilege IAM policy scoped to only its own Data_Store table, limited to the DynamoDB actions required for reads and atomic increments.
5. THE SAM_Template SHALL expose Allow_Origin as a deploy-time parameter with a default of `*` for the `dev` Stage and no default for the `prod` Stage.
6. WHERE an operator runs the service locally, THE Visitor_Counter_API SHALL support running the HTTP_API and Handler via `sam local start-api` as a development-only capability.
7. WHERE an operator runs the service locally via `sam local start-api`, THE Visitor_Counter_API SHALL allow the Handler's Data_Store endpoint to be redirected to a local DynamoDB through the standard `AWS_ENDPOINT_URL_DYNAMODB` environment variable, and WHERE that variable is unset (every deployed Stage), THE Handler SHALL resolve the Data_Store endpoint from the Lambda execution environment so that deployed behavior is unaffected.
