import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import {
  getCounter,
  getDocumentClient,
  incrementCounter,
  resetDocumentClient,
} from '../src/counter';

const ddbMock = mockClient(DynamoDBDocumentClient);

describe('counter service', () => {
  const tableName = 'test-visitor-counts';

  beforeEach(() => {
    ddbMock.reset();
    resetDocumentClient();
  });

  describe('getDocumentClient', () => {
    it('returns a singleton DynamoDBDocumentClient instance', () => {
      const client1 = getDocumentClient('us-east-1');
      const client2 = getDocumentClient('us-east-1');
      expect(client1).toBe(client2);
    });
  });

  describe('incrementCounter', () => {
    it('atomically increments and returns the new count for a page', async () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const docClient = DynamoDBDocumentClient.from(rawClient);
      const mockDocClient = mockClient(docClient);

      mockDocClient.on(UpdateCommand).resolves({
        Attributes: {
          pageId: 'homepage',
          count: 5,
          updatedAt: '2026-09-17T10:00:00.000Z',
        },
      });

      const result = await incrementCounter(docClient, tableName, 'homepage');

      expect(result).toEqual({
        pageId: 'homepage',
        count: 5,
        updatedAt: '2026-09-17T10:00:00.000Z',
      });

      const calls = mockDocClient.commandCalls(UpdateCommand);
      expect(calls.length).toBe(1);
      const input = calls[0]?.args[0]?.input;
      expect(input?.TableName).toBe(tableName);
      expect(input?.Key).toEqual({ pageId: 'homepage' });
      expect(input?.UpdateExpression).toBe(
        'SET #count = if_not_exists(#count, :zero) + :inc, #updatedAt = :now'
      );
      expect(input?.ExpressionAttributeValues?.[':zero']).toBe(0);
      expect(input?.ExpressionAttributeValues?.[':inc']).toBe(1);
    });

    it('handles first-time increment fallback when attributes are empty', async () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const docClient = DynamoDBDocumentClient.from(rawClient);
      const mockDocClient = mockClient(docClient);

      mockDocClient.on(UpdateCommand).resolves({});

      const result = await incrementCounter(docClient, tableName, 'new-page');

      expect(result.pageId).toBe('new-page');
      expect(result.count).toBe(1);
      expect(typeof result.updatedAt).toBe('string');
    });
  });

  describe('getCounter', () => {
    it('returns existing record when counter exists', async () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const docClient = DynamoDBDocumentClient.from(rawClient);
      const mockDocClient = mockClient(docClient);

      mockDocClient.on(GetCommand).resolves({
        Item: {
          pageId: 'portfolio',
          count: 42,
          updatedAt: '2026-09-17T09:30:00.000Z',
        },
      });

      const result = await getCounter(docClient, tableName, 'portfolio');

      expect(result).toEqual({
        pageId: 'portfolio',
        count: 42,
        updatedAt: '2026-09-17T09:30:00.000Z',
      });

      const calls = mockDocClient.commandCalls(GetCommand);
      expect(calls.length).toBe(1);
      expect(calls[0]?.args[0]?.input).toEqual({
        TableName: tableName,
        Key: { pageId: 'portfolio' },
      });
    });

    it('returns count 0 and null updatedAt when page does not exist yet', async () => {
      const rawClient = new DynamoDBClient({ region: 'us-east-1' });
      const docClient = DynamoDBDocumentClient.from(rawClient);
      const mockDocClient = mockClient(docClient);

      mockDocClient.on(GetCommand).resolves({});

      const result = await getCounter(docClient, tableName, 'unvisited-page');

      expect(result).toEqual({
        pageId: 'unvisited-page',
        count: 0,
        updatedAt: null,
      });
    });
  });
});
