# Atomic Web Visitor Counter API (AWS Lambda + DynamoDB)

A strongly typed TypeScript AWS Lambda function designed for high-concurrency, atomic visitor count tracking across websites, portfolios, and blogs. Backed by Amazon DynamoDB and fronted by Amazon API Gateway HTTP API (Payload v2).

---

## 🌟 Key Features

- **Atomic Increments**: Uses DynamoDB's `if_not_exists` atomic update expression to guarantee zero race conditions even under concurrent traffic.
- **RESTful Method Separation**:
  - `POST`: Atomically increments the counter and returns the updated count.
  - `GET`: Reads the current visitor count without incrementing (prevents double-counting during pre-rendering, refreshes, or previews).
- **Multi-Page & Multi-Domain Support**: Pass `?page=slug` or `{ "pageId": "slug" }` to track individual pages, or omit it to track a site-wide `global` counter.
- **Graceful Initialization**: Visiting an uninitialized page via `GET` returns `{ count: 0, updatedAt: null }` with HTTP 200 rather than failing.
- **CORS Built-In**: Configurable origin via `ALLOW_ORIGIN` (defaults to `*`) with full support for `OPTIONS` preflight requests.
- **Input Sanitization**: Rejects malformed JSON, excessive string lengths (>128 chars), and invalid characters with clean HTTP 400 responses.
- **Zero-Drift Bundle**: Built with `esbuild` to produce an optimized, self-contained single file (`dist/index.js`) and deployment archive (`dist/visitor-counter.zip`).
- **Comprehensive Test Suite**: Tested with Jest (`ts-jest`), `aws-sdk-client-mock`, and >95% test coverage.

---

## 🏗️ Architecture

```
[ Frontend Client (Fetch/XHR) ]
             │
             │ HTTPS (GET / POST)
             ▼
[ Amazon API Gateway HTTP API v2 ]
             │
             │ APIGatewayProxyEventV2
             ▼
[ AWS Lambda (Node.js 20.x / TypeScript) ]
             │
             │ Atomic UpdateCommand (SET count = if_not_exists(count, 0) + 1)
             ▼
[ Amazon DynamoDB Table ]
```

### DynamoDB Atomic Expression

```typescript
UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :inc, #updatedAt = :now',
ExpressionAttributeNames: {
  '#count': 'count',
  '#updatedAt': 'updatedAt',
},
ExpressionAttributeValues: {
  ':zero': 0,
  ':inc': 1,
  ':now': new Date().toISOString(),
},
ReturnValues: 'ALL_NEW',
```

---

## ⚙️ Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `TABLE_NAME` | **Yes** | — | The name of your DynamoDB table (e.g. `visitor-counts`). |
| `ALLOW_ORIGIN` | No | `*` | Allowed CORS origin (e.g. `https://yourdomain.com`). |
| `DEFAULT_PAGE_ID` | No | `global` | Fallback page identifier when no query param or body is provided. |
| `AWS_REGION` | No | `us-east-1` | AWS region (automatically populated by the Lambda runtime). |

---

## 🚀 AWS Setup & Deployment

### 1. Create DynamoDB Table

Run the following AWS CLI command to create the DynamoDB table with on-demand capacity:

```bash
aws dynamodb create-table \
  --table-name visitor-counts \
  --attribute-definitions AttributeName=pageId,AttributeType=S \
  --key-schema AttributeName=pageId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

### 2. IAM Policy for Lambda

Attach the following minimal IAM policy to the Lambda execution role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:UpdateItem"
      ],
      "Resource": "arn:aws:dynamodb:*:*:table/visitor-counts"
    }
  ]
}
```

### 3. Build & Package

Compile and package the Lambda function:

```bash
npm install
npm run package
```

This generates `dist/visitor-counter.zip` (under 600 KB).

### 4. Deploy Lambda Function

Deploy using AWS CLI or upload via the AWS Console:

```bash
aws lambda create-function \
  --function-name visitor-counter-api \
  --runtime nodejs20.x \
  --role arn:aws:iam::123456789012:role/visitor-counter-lambda-role \
  --handler index.handler \
  --zip-file fileb://dist/visitor-counter.zip \
  --environment Variables="{TABLE_NAME=visitor-counts,ALLOW_ORIGIN=*}"
```

To update existing Lambda code:

```bash
aws lambda update-function-code \
  --function-name visitor-counter-api \
  --zip-file fileb://dist/visitor-counter.zip
```

### 5. Attach API Gateway HTTP API

1. In the AWS Console, navigate to **API Gateway** > **Create API** > **HTTP API**.
2. Add an integration pointing to your Lambda function (`visitor-counter-api`).
3. Set routes:
   - `ANY /` or `POST /` and `GET /` pointing to the Lambda function.
4. Note your API invoke URL (e.g. `https://xxxxxx.execute-api.us-east-1.amazonaws.com`).

---

## 💻 Frontend Client Snippet

Add this drop-in HTML and JavaScript snippet to your website or blog:

```html
<div id="visitor-counter">
  👀 Views: <span id="view-count">Loading...</span>
</div>

<script>
  (async function() {
    const API_URL = 'https://YOUR_API_ID.execute-api.YOUR_REGION.amazonaws.com';
    // Use the current pathname or a custom page identifier
    const pageId = window.location.pathname.replace(/^\/|\/$/g, '') || 'home';

    try {
      // POST atomically records a view and retrieves the new count
      const response = await fetch(`${API_URL}?page=${encodeURIComponent(pageId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
      const data = await response.json();
      document.getElementById('view-count').textContent = data.count.toLocaleString();
    } catch (err) {
      console.warn('Visitor counter unavailable:', err);
      document.getElementById('view-count').textContent = '—';
    }
  })();
</script>
```

> **Tip:** If you have an admin dashboard or analytics preview where you want to inspect view counts without incrementing them, change `method: 'POST'` to `method: 'GET'`.

---

## 🧪 Development & Testing

```bash
# Run type checking
npm run typecheck

# Run test suite
npm test

# Run tests with coverage
npm run test:coverage

# Build single-file production bundle
npm run build
```

---

## 📄 License

MIT
