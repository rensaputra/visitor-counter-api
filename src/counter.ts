/**
 * Counter service for the Visitor Counter API.
 *
 * This is the only module that builds DynamoDB commands. It exposes the two
 * data operations backing the HTTP surface:
 *
 * - `readCount` (GET path): a single non-mutating `GetItem`.
 * - `incrementCount` (POST path): a single atomic `UpdateItem`.
 *
 * Both throw on Data_Store failure; the handler's top-level try/catch maps
 * those throws to HTTP 500 (Requirements 1.6, 2.4, 3.3, 5.3). Because an
 * increment is one atomic mutation, a thrown error can never leave a partially
 * applied increment (Requirements 1.6, 3.3, 8.3).
 */

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { CounterKey, CounterResult } from "./types";

/**
 * Parse a DynamoDB Number (N) attribute value into a JS number.
 *
 * DynamoDB stores numbers as strings in the `N` field; `count` is always a
 * non-negative integer for this table.
 */
function parseCount(n: string): number {
  return Number(n);
}

/**
 * Read the current Count for a target key (GET path).
 *
 * Issues exactly one `GetItem` and never a write. Returns the stored
 * `{ count, updatedAt }` when the Counter_Record exists (Req 2.1, 2.2), and
 * `{ count: 0, updatedAt: null }` when it is absent, without creating a record
 * (Req 5.1, 5.2). A `GetItem` failure rejects, which the handler maps to
 * HTTP 500 (Req 2.4, 5.3).
 */
export async function readCount(
  client: DynamoDBClient,
  tableName: string,
  key: CounterKey
): Promise<CounterResult> {
  const output = await client.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { pageId: { S: key.pageId } },
    })
  );

  const item = output.Item;
  if (!item || item.count?.N === undefined) {
    // Absent record (or one with no count): graceful zero, no write (Req 5).
    return { count: 0, updatedAt: null };
  }

  return {
    count: parseCount(item.count.N),
    updatedAt: item.updatedAt?.S ?? null,
  };
}

/**
 * Atomically increment the Count for a target key by one (POST path).
 *
 * Issues exactly one `UpdateItemCommand` using
 * `SET #c = if_not_exists(#c, :zero) + :one, #u = :now` with
 * `ReturnValues: "UPDATED_NEW"`, so the operation is a single atomic mutation
 * (Req 3.2) that creates the record at 1 when absent (Req 1.5) and returns the
 * post-increment value and timestamp in one round trip (Req 1.1, 1.4).
 *
 * DynamoDB serializes concurrent updates on the same item, so N concurrent
 * increments yield initial + N with no lost updates (Req 3.1). Any Data_Store
 * failure (including conflict/throttle) rejects with no partial write, which
 * the handler maps to HTTP 500 (Req 1.6, 3.3).
 */
export async function incrementCount(
  client: DynamoDBClient,
  tableName: string,
  key: CounterKey,
  now: string
): Promise<CounterResult> {
  const output = await client.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { pageId: { S: key.pageId } },
      UpdateExpression: "SET #c = if_not_exists(#c, :zero) + :one, #u = :now",
      ExpressionAttributeNames: { "#c": "count", "#u": "updatedAt" },
      ExpressionAttributeValues: {
        ":zero": { N: "0" },
        ":one": { N: "1" },
        ":now": { S: now },
      },
      ReturnValues: "UPDATED_NEW",
    })
  );

  const attributes = output.Attributes;
  return {
    count: attributes?.count?.N !== undefined ? parseCount(attributes.count.N) : 0,
    updatedAt: attributes?.updatedAt?.S ?? now,
  };
}
