/**
 * Shared application types for the Visitor Counter API.
 *
 * These types describe the pure-logic contracts used across the CORS,
 * response, router, input, and counter modules. They intentionally contain
 * no runtime logic so they can be imported freely without side effects.
 */

/**
 * Storage key identifying a single Counter_Record in the Data_Store.
 *
 * `pageId` holds either a user-supplied Page_Id or the reserved
 * Global_Counter key value (chosen outside the Permitted_Character_Set so it
 * cannot collide with any valid Page_Id).
 */
export interface CounterKey {
  pageId: string;
}

/**
 * The result of a counter operation (read or increment).
 *
 * - `count` is always a non-negative integer.
 * - `updatedAt` is an ISO 8601 timestamp, or `null` when the Counter_Record
 *   has never been incremented.
 */
export interface CounterResult {
  count: number;
  updatedAt: string | null;
}

/**
 * JSON body returned for a successful read or increment (HTTP 200).
 */
export interface CounterResponseBody {
  count: number;
  updatedAt: string | null;
}

/**
 * JSON body returned for any error response (HTTP 400/405/500).
 */
export interface ErrorResponseBody {
  error: string;
}

/**
 * The set of input-validation failures. Each variant maps to a fixed HTTP 400
 * response in the handler's error table.
 */
export type ValidationError =
  | { kind: "INVALID_JSON" }
  | { kind: "BODY_TOO_LARGE" }
  | { kind: "PAGE_ID_EMPTY" }
  | { kind: "PAGE_ID_TOO_LONG" }
  | { kind: "PAGE_ID_DISALLOWED_CHARS" };

/**
 * The outcome of resolving which counter a request targets.
 *
 * `pageId` is the resolved Page_Id, or `null` to indicate the Global_Counter.
 */
export interface TargetResolution {
  pageId: string | null;
}

/**
 * Classified HTTP method. `OTHER` represents any method whose
 * case-insensitive value is not GET or POST (including OPTIONS, whose
 * preflight is answered by the HTTP API and never reaches the Handler).
 */
export type Method = "GET" | "POST" | "OTHER";
