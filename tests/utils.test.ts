import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import {
  buildCorsHeaders,
  buildErrorResponse,
  buildResponse,
  extractPageId,
  validatePageId,
} from '../src/utils';

describe('utils', () => {
  describe('validatePageId', () => {
    it('returns error for empty or whitespace pageId', () => {
      expect(validatePageId('')).toBe('pageId cannot be empty');
      expect(validatePageId('   ')).toBe('pageId cannot be empty');
    });

    it('returns error for overly long pageId', () => {
      expect(validatePageId('x'.repeat(129))).toContain('cannot exceed 128 characters');
    });

    it('returns error for disallowed special characters', () => {
      expect(validatePageId('page!@#')).toContain('can only contain alphanumeric characters');
      expect(validatePageId('page with spaces')).toContain('can only contain alphanumeric characters');
    });

    it('returns null for valid pageId formats', () => {
      expect(validatePageId('home')).toBeNull();
      expect(validatePageId('blog/post-1_v2.0')).toBeNull();
    });
  });

  describe('buildCorsHeaders', () => {
    it('returns expected CORS headers', () => {
      const headers = buildCorsHeaders('https://example.com');
      expect(headers['Access-Control-Allow-Origin']).toBe('https://example.com');
      expect(headers['Access-Control-Allow-Methods']).toBe('GET, POST, OPTIONS');
    });
  });

  describe('buildResponse & buildErrorResponse', () => {
    it('constructs formatted APIGatewayProxyResultV2', () => {
      const result = buildResponse(200, { ok: true }, '*') as any;
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');
      expect(result.headers['Access-Control-Allow-Origin']).toBe('*');
      expect(JSON.parse(result.body)).toEqual({ ok: true });
    });

    it('constructs formatted error response', () => {
      const result = buildErrorResponse(404, 'NotFound', 'Page missing', '*') as any;
      expect(result.statusCode).toBe(404);
      expect(JSON.parse(result.body)).toEqual({
        error: 'NotFound',
        message: 'Page missing',
      });
    });
  });

  describe('extractPageId', () => {
    const baseEvent: APIGatewayProxyEventV2 = {
      version: '2.0',
      routeKey: '$default',
      rawPath: '/',
      rawQueryString: '',
      headers: {},
      requestContext: {} as any,
      isBase64Encoded: false,
    };

    it('extracts from page query parameter', () => {
      const res = extractPageId(
        { ...baseEvent, queryStringParameters: { page: 'portfolio' } },
        'global'
      );
      expect(res).toEqual({ pageId: 'portfolio' });
    });

    it('extracts from pageId query parameter', () => {
      const res = extractPageId(
        { ...baseEvent, queryStringParameters: { pageId: 'contact' } },
        'global'
      );
      expect(res).toEqual({ pageId: 'contact' });
    });

    it('extracts from JSON body', () => {
      const res = extractPageId(
        { ...baseEvent, body: JSON.stringify({ pageId: 'about-us' }) },
        'global'
      );
      expect(res).toEqual({ pageId: 'about-us' });
    });

    it('falls back to defaultPageId if body is empty or has no pageId field', () => {
      const res1 = extractPageId(
        { ...baseEvent, body: JSON.stringify({}) },
        'global'
      );
      expect(res1).toEqual({ pageId: 'global' });

      const res2 = extractPageId(baseEvent, 'default-page');
      expect(res2).toEqual({ pageId: 'default-page' });
    });
  });
});
