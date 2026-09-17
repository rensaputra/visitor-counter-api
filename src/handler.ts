import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
  Handler,
} from 'aws-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { loadConfig } from './config';
import { getCounter, getDocumentClient, incrementCounter } from './counter';
import { AppConfig } from './types';
import {
  buildCorsHeaders,
  buildErrorResponse,
  buildResponse,
  extractPageId,
} from './utils';

/**
 * Creates an instance of the Lambda handler with optional dependencies for testing.
 */
export function createHandler(
  configProvider: () => AppConfig = () => loadConfig(),
  clientProvider: (region: string) => DynamoDBDocumentClient = (region) =>
    getDocumentClient(region)
): Handler<APIGatewayProxyEventV2, APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    // 1. Resolve configuration
    let config: AppConfig;
    try {
      config = configProvider();
    } catch (err) {
      console.error('Configuration error:', err);
      return buildErrorResponse(
        500,
        'InternalServerError',
        'Server configuration error',
        '*'
      );
    }

    const { allowOrigin, tableName, defaultPageId, awsRegion } = config;
    const httpMethod = event.requestContext.http.method.toUpperCase();

    // 2. Handle CORS Preflight (OPTIONS)
    if (httpMethod === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: buildCorsHeaders(allowOrigin),
      };
    }

    // 3. Extract and validate pageId
    const { pageId, error: extractionError } = extractPageId(
      event,
      defaultPageId
    );

    if (extractionError) {
      return buildErrorResponse(
        400,
        'BadRequest',
        extractionError,
        allowOrigin
      );
    }

    const docClient = clientProvider(awsRegion);

    // 4. Route based on HTTP method
    try {
      switch (httpMethod) {
        case 'POST': {
          const result = await incrementCounter(docClient, tableName, pageId);
          return buildResponse(200, result, allowOrigin);
        }

        case 'GET': {
          const result = await getCounter(docClient, tableName, pageId);
          return buildResponse(200, result, allowOrigin);
        }

        default: {
          return buildErrorResponse(
            405,
            'MethodNotAllowed',
            `Method ${httpMethod} not allowed. Supported methods are GET and POST.`,
            allowOrigin
          );
        }
      }
    } catch (err) {
      console.error('DynamoDB operation failed:', err);
      return buildErrorResponse(
        500,
        'InternalServerError',
        'Failed to process visitor counter request',
        allowOrigin
      );
    }
  };
}

/**
 * Default exported AWS Lambda handler.
 */
export const handler = createHandler();
