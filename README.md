# Visitor Counter API

A serverless HTTP service that tracks page visit counts on AWS. Built with
TypeScript, deployed as an AWS Lambda function behind an API Gateway HTTP API,
with counts persisted in Amazon DynamoDB. Infrastructure and packaging are
managed by AWS SAM.

## Prerequisites

- Node.js 24.x and npm
- [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
- AWS credentials configured (for `sam deploy`)

## Install

```bash
npm install
```

## Test

The Jest suite runs with a coverage gate (≥95% statements, ≥90% branches).

```bash
npm test            # run the suite
npm run test:coverage   # run with coverage (enforces the gate)
npm run typecheck   # type-check without emitting
```

## Validate and build (SAM)

`sam build` uses the esbuild BuildMethod to bundle the Handler and all runtime
dependencies into a single self-contained artifact. No Docker is required for
validate or build.

```bash
sam validate --lint   # lint and validate template.yaml
sam build             # bundle the Handler into .aws-sam/build/
```

A successful build writes the bundled Handler to
`.aws-sam/build/CounterFunction/index.js` and exits 0. A failed build exits
non-zero and produces no artifact.

## Deploy

Two environments are configured in `samconfig.toml`, each as a separate
CloudFormation stack in the same AWS account:

```bash
sam deploy --config-env dev    # Stage=dev,  AllowOrigin=*
sam deploy --config-env prod   # Stage=prod, AllowOrigin=<explicit origin>
```

`prod` must supply an explicit `AllowOrigin` (never `*`) — set the production
front-end origin in `samconfig.toml` before deploying.

- **Prod later**: edit the `prod` block in `samconfig.toml` — replace
  `https://your-frontend.example.com` with your real front-end origin (prod
  rejects `*`), then `sam deploy --config-env prod`.
- **Teardown** when you're done: `sam delete --stack-name visitor-counter-dev`.

## Smoke-test a deployed stack

After a deploy, CloudFormation prints an `ApiEndpoint` output (also retrievable
with the command below). The endpoint already includes the stage segment, e.g.
`https://<api-id>.execute-api.<region>.amazonaws.com/dev`.

```bash
# Fetch the ApiEndpoint from the deployed stack
aws cloudformation describe-stacks \
  --stack-name visitor-counter-dev \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text
```

Then exercise the API:

```bash
# GET the current count for page "home"
curl "<ApiEndpoint>/?page=home"
# -> {"count":0,"updatedAt":null}

# POST to increment it
curl -X POST "<ApiEndpoint>/?page=home"
# -> {"count":1,"updatedAt":"2026-01-01T00:00:00.000Z"}
```

> **Mind the trailing slash.** The routes are `GET /` and `POST /`, so the
> request path must be `/`. Keep the slash between the stage and the query
> string: use `.../dev/?page=home` (path `/`, matches) — **not**
> `.../dev?page=home`, which resolves to an empty path and returns
> `404 {"message":"Not Found"}`. Also make sure the stage segment (`/dev`) is
> present; omitting it also yields a 404. When building the URL in code,
> construct it as `` `${apiEndpoint}/?page=${encodeURIComponent(page)}` `` so
> the trailing slash is always included.

## Local development (`sam local start-api`)

> **Dev-only, manual step. Requires Docker. NOT part of CI.**

You can run the HTTP API and Handler locally against a local DynamoDB.

`sam local start-api` emulates the API Gateway HTTP API and invokes the Handler
inside a local Lambda container, so it **requires Docker to be installed and
running** on your machine. This is a development-only convenience for exercising
the API locally.

To run against a local DynamoDB, three things must line up (each was a real
gotcha worth calling out):

- The Handler reads an optional `AWS_ENDPOINT_URL_DYNAMODB` and, when set,
  passes it as the client `endpoint` (see `src/index.ts`). When unset (every
  deployed Stage) the client resolves the real DynamoDB endpoint, so production
  is unaffected.
- `template.yaml` declares `AWS_ENDPOINT_URL_DYNAMODB: ""` under the function's
  `Environment.Variables`. SAM's `--env-vars` only *overrides* variables that
  already exist on the function, so the key must be declared (empty) for the
  local override to take effect.
- DynamoDB Local must run with `-sharedDb` so tables are visible regardless of
  region/credentials. Without it, tables are partitioned per region + access
  key and the container sees an empty partition ("non-existent table").

1. Start DynamoDB Local on a shared docker network, with `-sharedDb` so the
   Lambda container and your CLI share one table set:

   ```bash
   docker network create sam-local 2>/dev/null || true
   docker run -d --name dynamodb-local --network sam-local -p 8000:8000 \
     amazon/dynamodb-local -jar DynamoDBLocal.jar -sharedDb -inMemory
   ```

   > `-inMemory` keeps setup simple but is wiped on restart — recreate the
   > table (step 2) after restarting the container.

2. Create the table (matches the `visitor-counter-dev` name and `pageId` key
   the stack uses for the `dev` Stage):

   ```bash
   aws dynamodb create-table \
     --table-name visitor-counter-dev \
     --attribute-definitions AttributeName=pageId,AttributeType=S \
     --key-schema AttributeName=pageId,KeyType=HASH \
     --billing-mode PAY_PER_REQUEST \
     --endpoint-url http://localhost:8000 \
     --region us-east-1
   ```

3. Create your local env-vars file from the committed template, then build and
   run the API on the same network (the container reaches the DB by its
   container name `dynamodb-local`, not `localhost`):

   ```bash
   cp env.json.example env.json
   sam build
   sam local start-api \
     --docker-network sam-local \
     --env-vars env.json \
     --parameter-overrides Stage=dev
   ```

Then `GET http://127.0.0.1:3000/?page=test` returns
`{"count":0,"updatedAt":null}`, and `POST` increments it. `env.json.example`
holds only placeholder local values; the working `env.json` is git-ignored so
any local endpoints or credentials you add stay out of version control.

It is **not part of continuous integration**: CI does not run
`sam local start-api` and does not require Docker. The CI gate consists of the
Jest coverage gate, `sam validate --lint`, and `sam build` — all of which run
without Docker.
