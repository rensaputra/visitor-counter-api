import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CounterRequestBody, ErrorResponse } from './types';

const PAGE_ID_REGEX = /^[a-zA-Z0-9_\-./]+$/;
const MAX_PAGE_ID_LENGTH = 128;

/**
 * Generates CORS headers based on the allowed origin configuration.
 */
export function buildCorsHeaders(allowOrigin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Builds a standardized API Gateway HTTP API v2 JSON response.
 */
export function buildResponse(
  statusCode: number,
  body: unknown,
  allowOrigin: string
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(allowOrigin),
    },
    body: JSON.stringify(body),
  };
}

/**
 * Builds a standardized error response.
 */
export function buildErrorResponse(
  statusCode: number,
  error: string,
  message: string,
  allowOrigin: string
): APIGatewayProxyResultV2 {
  const errorPayload: ErrorResponse = { error, message };
  return buildResponse(statusCode, errorPayload, allowOrigin);
}

/**
 * Validates a pageId format and length.
 * Returns null if valid, or an error string if invalid.
 */
export function validatePageId(pageId: string): string | null {
  if (!pageId || pageId.trim().length === 0) {
    return 'pageId cannot be empty';
  }

  if (pageId.length > MAX_PAGE_ID_LENGTH) {
    return `pageId cannot exceed ${MAX_PAGE_ID_LENGTH} characters`;
  }

  if (!PAGE_ID_REGEX.test(pageId)) {
    return 'pageId can only contain alphanumeric characters, hyphens, underscores, dots, and slashes';
  }

  return null;
}

/**
 * Extracts and sanitizes the pageId from an API Gateway HTTP API v2 event.
 * Checks query string parameters first ('page' or 'pageId'), then JSON request body,
 * falling back to the configured defaultPageId.
 */
export function extractPageId(
  event: APIGatewayProxyEventV2,
  defaultPageId: string
): { pageId: string; error?: string } {
  // 1. Check query parameters
  const queryParam =
    event.queryStringParameters?.page || event.queryStringParameters?.pageId;

  if (queryParam) {
    const trimmed = queryParam.trim();
    const validationError = validatePageId(trimmed);
    if (validationError) {
      return { pageId: '', error: validationError };
    }
    return { pageId: trimmed };
  }

  // 2. Check JSON request body if POST
  if (event.body) {
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf-8')
        : event.body;

      const parsed = JSON.parse(rawBody) as CounterRequestBody;
      if (parsed && typeof parsed.pageId === 'string' && parsed.pageId.trim().length > 0) {
        const trimmed = parsed.pageId.trim();
        const validationError = validatePageId(trimmed);
        if (validationError) {
          return { pageId: '', error: validationError };
        }
        return { pageId: trimmed };
      }
    } catch {
      return { pageId: '', error: 'Malformed JSON request body' };
    }
  }

  // 3. Fallback to default pageId
  return { pageId: defaultPageId };
}
