import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { createHandler } from '../src/handler';
import { AppConfig } from '../src/types';

const rawClient = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(rawClient);
const ddbMock = mockClient(docClient);

function createMockEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'id.execute-api.us-east-1.amazonaws.com',
      domainPrefix: 'id',
      http: {
        method: 'GET',
        path: '/',
        protocol: 'HTTP/1.1',
        sourceIp: '192.0.2.1',
        userAgent: 'Mozilla/5.0',
      },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '17/Sep/2026:10:00:00 +0000',
      timeEpoch: 1789639200000,
    },
    isBase64Encoded: false,
    ...overrides,
  };
}

describe('handler (API Gateway HTTP API v2)', () => {
  const testConfig: AppConfig = {
    tableName: 'visitor-table',
    allowOrigin: 'https://example.com',
    defaultPageId: 'global',
    awsRegion: 'us-east-1',
  };

  const handler = createHandler(
    () => testConfig,
    () => docClient
  );

  beforeEach(() => {
    ddbMock.reset();
  });

  describe('CORS preflight (OPTIONS)', () => {
    it('returns 204 No Content with CORS headers', async () => {
      const event = createMockEvent({
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'OPTIONS',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(204);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(response.headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    });
  });

  describe('GET requests', () => {
    it('reads counter for specified query parameter page', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          pageId: 'articles/typescript-lambda',
          count: 15,
          updatedAt: '2026-09-17T08:00:00.000Z',
        },
      });

      const event = createMockEvent({
        queryStringParameters: { page: 'articles/typescript-lambda' },
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'GET',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      expect(response.headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        pageId: 'articles/typescript-lambda',
        count: 15,
        updatedAt: '2026-09-17T08:00:00.000Z',
      });
    });

    it('falls back to default pageId when no parameter is passed', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          pageId: 'global',
          count: 100,
          updatedAt: '2026-09-17T09:00:00.000Z',
        },
      });

      const event = createMockEvent({
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'GET',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pageId).toBe('global');
      expect(body.count).toBe(100);
    });

    it('returns count 0 if page has not been visited yet', async () => {
      ddbMock.on(GetCommand).resolves({});

      const event = createMockEvent({
        queryStringParameters: { page: 'brand-new-page' },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        pageId: 'brand-new-page',
        count: 0,
        updatedAt: null,
      });
    });
  });

  describe('POST requests', () => {
    it('atomically increments counter from body payload', async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          pageId: 'projects',
          count: 1,
          updatedAt: '2026-09-17T10:15:00.000Z',
        },
      });

      const event = createMockEvent({
        body: JSON.stringify({ pageId: 'projects' }),
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'POST',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body).toEqual({
        pageId: 'projects',
        count: 1,
        updatedAt: '2026-09-17T10:15:00.000Z',
      });
    });

    it('handles base64 encoded request body', async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          pageId: 'encoded-page',
          count: 3,
          updatedAt: '2026-09-17T10:15:00.000Z',
        },
      });

      const event = createMockEvent({
        body: Buffer.from(JSON.stringify({ pageId: 'encoded-page' })).toString('base64'),
        isBase64Encoded: true,
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'POST',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pageId).toBe('encoded-page');
    });

    it('increments default global counter when no pageId is passed in POST', async () => {
      ddbMock.on(UpdateCommand).resolves({
        Attributes: {
          pageId: 'global',
          count: 25,
          updatedAt: '2026-09-17T10:15:00.000Z',
        },
      });

      const event = createMockEvent({
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'POST',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.pageId).toBe('global');
      expect(body.count).toBe(25);
    });
  });

  describe('Validation and error handling', () => {
    it('returns 400 for invalid pageId characters', async () => {
      const event = createMockEvent({
        queryStringParameters: { page: 'unsafe<script>alert(1)</script>' },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BadRequest');
    });

    it('returns 400 for pageId exceeding maximum length', async () => {
      const event = createMockEvent({
        queryStringParameters: { page: 'a'.repeat(129) },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BadRequest');
      expect(body.message).toContain('cannot exceed 128 characters');
    });

    it('returns 400 for malformed JSON body', async () => {
      const event = createMockEvent({
        body: 'invalid-non-json',
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'POST',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('BadRequest');
      expect(body.message).toBe('Malformed JSON request body');
    });

    it('returns 405 for unsupported HTTP method', async () => {
      const event = createMockEvent({
        requestContext: {
          ...createMockEvent().requestContext,
          http: {
            ...createMockEvent().requestContext.http,
            method: 'DELETE',
          },
        },
      });

      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(405);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('MethodNotAllowed');
    });

    it('returns 500 when configuration loading fails', async () => {
      const brokenHandler = createHandler(() => {
        throw new Error('Config missing');
      });

      const event = createMockEvent();
      const response = await brokenHandler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('InternalServerError');
    });

    it('returns 500 when DynamoDB operation throws', async () => {
      ddbMock.on(GetCommand).rejects(new Error('DynamoDB connection timeout'));

      const event = createMockEvent();
      const response = await handler(event, {} as any, () => {}) as any;

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('InternalServerError');
      expect(body.message).toBe('Failed to process visitor counter request');
    });
  });
});
