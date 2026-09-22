/**
 * Tests for the counter service (`src/counter.ts`): `readCount` and
 * `incrementCount`.
 *
 * These tests use `aws-sdk-client-mock` to mock the `DynamoDBClient` so no
 * live Data_Store is touched (Requirement 10.2), and `fast-check` for the
 * property-based tests (each `fc.assert` runs a minimum of 100 iterations).
 *
 * Task coverage:
 * - 7.2 Property 3: Read returns stored (or zero) count without mutating.
 * - 7.4 Property 1: Increment adds exactly one and records the timestamp.
 * - 7.5 Property 5: Concurrent increments never lose updates.
 * - 7.6 Example tests for Data_Store failure mapping.
 */

import fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { readCount, incrementCount } from "./counter";
import type { CounterKey } from "./types";

const ddbMock = mockClient(DynamoDBClient);
const TABLE_NAME = "visitor-counter-table";

/**
 * A key value drawn from the Permitted_Character_Set plus the reserved global
 * key. The counter service treats the key as an opaque string, so this just
 * exercises a representative spread of target keys.
 */
const keyArb: fc.Arbitrary<CounterKey> = fc.oneof(
  fc
    .stringMatching(/^[A-Za-z0-9\-_.\/]+$/)
    .filter((s) => s.length >= 1 && s.length <= 128)
    .map((pageId) => ({ pageId })),
  fc.constant<CounterKey>({ pageId: "*global*" }),
);

/** A non-negative integer Count, covering zero and large values. */
const countArb = fc.integer({ min: 0, max: 1_000_000 });

/** An ISO 8601 timestamp string. */
const isoTimestampArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

beforeEach(() => {
  ddbMock.reset();
});

describe("readCount", () => {
  // Feature: visitor-counter-api, Property 3: Read returns stored (or zero) count without mutating
  it("returns the stored count when present and { count: 0, updatedAt: null } when absent, never issuing a write", async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        // Either a present record (arbitrary count + optional updatedAt) or an
        // absent record.
        fc.oneof(
          fc.record({
            present: fc.constant(true),
            count: countArb,
            updatedAt: fc.oneof(isoTimestampArb, fc.constant<null>(null)),
          }),
          fc.record({ present: fc.constant(false) }),
        ),
        async (key, scenario) => {
          ddbMock.reset();

          if (scenario.present) {
            const item: Record<string, { S: string } | { N: string }> = {
              pageId: { S: key.pageId },
              count: { N: String(scenario.count) },
            };
            if (scenario.updatedAt !== null) {
              item.updatedAt = { S: scenario.updatedAt };
            }
            ddbMock.on(GetItemCommand).resolves({ Item: item });
          } else {
            // Absent: DynamoDB returns no Item.
            ddbMock.on(GetItemCommand).resolves({});
          }

          const result = await readCount(new DynamoDBClient({}), TABLE_NAME, key);

          if (scenario.present) {
            expect(result.count).toBe(scenario.count);
            expect(result.updatedAt).toBe(scenario.updatedAt);
          } else {
            expect(result).toEqual({ count: 0, updatedAt: null });
          }

          // Exactly one GetItem was issued, and no write command was ever sent.
          expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(1);
          expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
          expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("incrementCount", () => {
  // Feature: visitor-counter-api, Property 1: Increment adds exactly one and records the timestamp
  it("adds exactly one to the initial count, records the timestamp, and issues exactly one atomic UpdateItem", async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        // The initial state: an existing count c >= 0, or absent (treated as 0).
        fc.oneof(
          countArb.map((c) => ({ initial: c })),
          fc.constant<{ initial: number }>({ initial: 0 }),
        ),
        isoTimestampArb,
        async (key, state, now) => {
          ddbMock.reset();

          // Model DynamoDB's if_not_exists(count, 0) + 1 semantics: the mock
          // returns the post-increment Attributes (UPDATED_NEW) so the returned
          // Count is initial + 1 and updatedAt is the increment timestamp.
          const expectedCount = state.initial + 1;
          ddbMock.on(UpdateItemCommand).resolves({
            Attributes: {
              count: { N: String(expectedCount) },
              updatedAt: { S: now },
            },
          });

          const result = await incrementCount(
            new DynamoDBClient({}),
            TABLE_NAME,
            key,
            now,
          );

          // Returned Count is exactly c + 1 and updatedAt is the increment time.
          expect(result.count).toBe(expectedCount);
          expect(result.updatedAt).toBe(now);

          // Exactly one atomic UpdateItem, and no read-modify-write (no GetItem).
          const updateCalls = ddbMock.commandCalls(UpdateItemCommand);
          expect(updateCalls).toHaveLength(1);
          expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);

          // The single command targets the requested key and uses the atomic
          // increment expression against the correct table.
          const call = updateCalls[0];
          if (!call) throw new Error("expected one UpdateItem call");
          const input = call.args[0].input;
          expect(input.TableName).toBe(TABLE_NAME);
          expect(input.Key).toEqual({ pageId: { S: key.pageId } });
          expect(input.UpdateExpression).toContain("if_not_exists");
          expect(input.ReturnValues).toBe("UPDATED_NEW");
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: visitor-counter-api, Property 5: Concurrent increments never lose updates
  it("yields a final count of c + N for N concurrent increments against atomic ADD semantics", async () => {
    await fc.assert(
      fc.asyncProperty(
        keyArb,
        countArb,
        fc.integer({ min: 2, max: 50 }),
        isoTimestampArb,
        async (key, initial, n, now) => {
          ddbMock.reset();

          // Stateful mock modeling DynamoDB's atomic ADD on a single item:
          // each UpdateItem serializes and increments the stored count by one,
          // returning the post-increment value (UPDATED_NEW). Concurrency is
          // simulated by serializing the mutations, which is exactly the
          // guarantee DynamoDB provides for single-item updates.
          let stored = initial;
          ddbMock.on(UpdateItemCommand).callsFake(async () => {
            // if_not_exists(count, 0) + 1 semantics: absent is treated as 0.
            stored = stored + 1;
            return {
              Attributes: {
                count: { N: String(stored) },
                updatedAt: { S: now },
              },
            };
          });

          // Fire N concurrent increments and await them all.
          const client = new DynamoDBClient({});
          const results = await Promise.all(
            Array.from({ length: n }, () =>
              incrementCount(client, TABLE_NAME, key, now),
            ),
          );

          // The final stored count equals initial + N, with no lost updates.
          expect(stored).toBe(initial + n);
          expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(n);

          // Each increment applied exactly once: the returned counts are the
          // contiguous range (initial, initial + N] in some order.
          const returned = results.map((r) => r.count).sort((a, b) => a - b);
          const expected = Array.from(
            { length: n },
            (_, i) => initial + i + 1,
          );
          expect(returned).toEqual(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Data_Store failure mapping (example tests)", () => {
  // Requirements 2.4, 5.3: a GetItem failure rejects (handler maps to 500).
  it("readCount rejects when the GetItem command rejects", async () => {
    ddbMock.on(GetItemCommand).rejects(new Error("DynamoDB unavailable"));

    await expect(
      readCount(new DynamoDBClient({}), TABLE_NAME, { pageId: "page-1" }),
    ).rejects.toThrow("DynamoDB unavailable");

    // Read never issues a write, even on failure.
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
  });

  // Requirements 1.6, 3.3, 10.3: an UpdateItem failure rejects; exactly one
  // command is attempted and there is no partial write.
  it("incrementCount rejects when the UpdateItem command rejects, attempting exactly one command with no partial write", async () => {
    ddbMock.on(UpdateItemCommand).rejects(new Error("Increment failed"));

    await expect(
      incrementCount(
        new DynamoDBClient({}),
        TABLE_NAME,
        { pageId: "page-1" },
        "2024-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow("Increment failed");

    // Exactly one command was attempted (the single atomic UpdateItem)...
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    // ...and no partial write occurred via any other write path, and there was
    // no read-modify-write.
    expect(ddbMock.commandCalls(PutItemCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });

  // Requirement 3.3: a conflict/throttle-style rejection also rejects (mapped
  // to 500), never silently losing the increment.
  it("incrementCount rejects on a conflict/throttle-style error", async () => {
    const conflict = Object.assign(
      new Error("The conditional request failed / throughput exceeded"),
      { name: "ProvisionedThroughputExceededException" },
    );
    ddbMock.on(UpdateItemCommand).rejects(conflict);

    await expect(
      incrementCount(
        new DynamoDBClient({}),
        TABLE_NAME,
        { pageId: "page-1" },
        "2024-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow("The conditional request failed / throughput exceeded");

    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(GetItemCommand)).toHaveLength(0);
  });
});

describe("incrementCount - UPDATED_NEW fallback handling (example tests)", () => {
  // Covers the `attributes?.count?.N !== undefined ? parseCount(...) : 0`
  // fallback when UpdateItem resolves with NO Attributes at all: the returned
  // count defaults to 0 and updatedAt falls back to `now`.
  it("falls back to { count: 0, updatedAt: now } when UpdateItem returns no Attributes", async () => {
    const now = "2024-03-03T00:00:00.000Z";
    // Resolve with an empty response object (no Attributes field).
    ddbMock.on(UpdateItemCommand).resolves({});

    const result = await incrementCount(
      new DynamoDBClient({}),
      TABLE_NAME,
      { pageId: "page-1" },
      now,
    );

    expect(result).toEqual({ count: 0, updatedAt: now });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  // Covers the count fallback when Attributes is present but has no `count`
  // field: count defaults to 0 while updatedAt is read from Attributes.
  it("falls back count to 0 when Attributes is present but missing count", async () => {
    const now = "2024-03-03T00:00:00.000Z";
    const storedUpdatedAt = "2024-03-04T12:00:00.000Z";
    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: {
        updatedAt: { S: storedUpdatedAt },
      },
    });

    const result = await incrementCount(
      new DynamoDBClient({}),
      TABLE_NAME,
      { pageId: "page-1" },
      now,
    );

    expect(result).toEqual({ count: 0, updatedAt: storedUpdatedAt });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });

  // Covers the `attributes?.updatedAt?.S ?? now` fallback when Attributes has
  // a count but no updatedAt: updatedAt falls back to the supplied `now`.
  it("falls back updatedAt to now when Attributes has count but no updatedAt", async () => {
    const now = "2024-03-03T00:00:00.000Z";
    ddbMock.on(UpdateItemCommand).resolves({
      Attributes: {
        count: { N: "9" },
      },
    });

    const result = await incrementCount(
      new DynamoDBClient({}),
      TABLE_NAME,
      { pageId: "page-1" },
      now,
    );

    expect(result).toEqual({ count: 9, updatedAt: now });
    expect(ddbMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  });
});
