import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { CounterRecord, CounterResponse } from './types';

let defaultDocClient: DynamoDBDocumentClient | null = null;

/**
 * Returns or initializes a shared DynamoDBDocumentClient instance.
 */
export function getDocumentClient(region?: string): DynamoDBDocumentClient {
  if (!defaultDocClient) {
    const rawClient = new DynamoDBClient({ region });
    defaultDocClient = DynamoDBDocumentClient.from(rawClient, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
  }
  return defaultDocClient;
}

/**
 * Resets the cached document client (primarily useful in unit testing).
 */
export function resetDocumentClient(): void {
  defaultDocClient = null;
}

/**
 * Atomically increments the visitor counter for a given pageId.
 * If the record does not exist, it initializes count to 0 + 1 = 1.
 */
export async function incrementCounter(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  pageId: string
): Promise<CounterResponse> {
  const now = new Date().toISOString();

  const command = new UpdateCommand({
    TableName: tableName,
    Key: { pageId },
    UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :inc, #updatedAt = :now',
    ExpressionAttributeNames: {
      '#count': 'count',
      '#updatedAt': 'updatedAt',
    },
    ExpressionAttributeValues: {
      ':zero': 0,
      ':inc': 1,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  });

  const response = await docClient.send(command);
  const attributes = response.Attributes as Partial<CounterRecord> | undefined;

  return {
    pageId,
    count: attributes?.count ?? 1,
    updatedAt: attributes?.updatedAt ?? now,
  };
}

/**
 * Retrieves the current visitor counter for a given pageId without incrementing.
 * Returns count: 0 and updatedAt: null if the counter does not exist.
 */
export async function getCounter(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  pageId: string
): Promise<CounterResponse> {
  const command = new GetCommand({
    TableName: tableName,
    Key: { pageId },
  });

  const response = await docClient.send(command);

  if (!response.Item) {
    return {
      pageId,
      count: 0,
      updatedAt: null,
    };
  }

  const item = response.Item as Partial<CounterRecord>;

  return {
    pageId,
    count: typeof item.count === 'number' ? item.count : 0,
    updatedAt: item.updatedAt ?? null,
  };
}
