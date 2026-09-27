/**
 * Input module: target resolution and storage-key derivation.
 *
 * A pure-logic layer (no I/O) responsible for two concerns:
 *
 * 1. Resolving which counter a request targets from its query string and
 *    parsed JSON body ({@link resolveTarget}).
 * 2. Deriving the deterministic, injective Data_Store key for a resolved
 *    target ({@link deriveCounterKey}), including the reserved key used for
 *    the Global_Counter.
 * 3. Validating a resolved Page_Id against the length and character-set rules
 *    ({@link validatePageId}) and decoding/size-checking/parsing a request
 *    body ({@link parseBody}).
 *
 * The Page_Id and JSON-body rules are expressed as Zod schemas. Behavior is
 * identical to the previous hand-rolled checks: the Page_Id length rule counts
 * Unicode code points (not UTF-16 units) via a custom refinement rather than
 * `z.string().max()`, and the body size gate still runs on the raw decoded
 * bytes before JSON parsing. Each schema failure is mapped back to the fixed
 * {@link ValidationError} kinds the handler's error table depends on.
 */

import { z } from "zod";

import type { CounterKey, TargetResolution, ValidationError } from "./types";

/**
 * Reserved storage key for the Global_Counter.
 *
 * This value is deliberately chosen to contain a character (`*`) that is
 * outside the Permitted_Character_Set (ASCII letters, digits, `-`, `_`, `.`,
 * `/`). Because no valid user-supplied Page_Id can contain `*`, the reserved
 * key can never collide with a Page_Id-derived key, which keeps key
 * derivation injective across the whole input space (Requirements 4.5, 4.6).
 */
export const GLOBAL_COUNTER_KEY = "*global*";

/**
 * Extract a non-empty string from an arbitrary value.
 *
 * Returns the value unchanged when it is a non-empty string, or `null` when
 * it is absent, not a string, or the empty string. Used to apply the
 * "non-empty string" precedence rules for both the `page` query parameter and
 * the `pageId` body field.
 *
 * @param value - The candidate value (query param or body field).
 * @returns The non-empty string, or `null`.
 */
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Resolve which counter a request targets.
 *
 * Precedence (Requirements 4.1–4.4):
 * - A non-empty `page` query string parameter wins and is used as the Page_Id
 *   (Requirement 4.1), even when a `pageId` body field is also present
 *   (Requirement 4.3 — the body field is ignored).
 * - Otherwise, when the body is a JSON object with a non-empty string `pageId`
 *   field, that field value is used as the Page_Id (Requirement 4.2).
 * - Otherwise — when neither a non-empty `page` query parameter nor a
 *   non-empty `pageId` body field is supplied (both absent, both empty, or one
 *   absent and the other empty) — the request resolves to the Global_Counter,
 *   represented by a `null` `pageId` (Requirement 4.4).
 *
 * This function does not validate the resolved Page_Id (length or permitted
 * characters); it only decides which selector, if any, applies. Validation is
 * performed separately.
 *
 * @param queryStringParameters - The request's query string parameters, or
 *   `undefined` when none were supplied.
 * @param parsedBody - The already-parsed JSON body, or any non-object value
 *   (including `undefined`/`null`) when no usable body was supplied.
 * @returns A {@link TargetResolution} whose `pageId` is the resolved Page_Id,
 *   or `null` for the Global_Counter.
 */
export function resolveTarget(
  queryStringParameters: Record<string, string> | undefined,
  parsedBody: unknown
): TargetResolution {
  const queryPage = nonEmptyString(queryStringParameters?.["page"]);
  if (queryPage !== null) {
    return { pageId: queryPage };
  }

  if (typeof parsedBody === "object" && parsedBody !== null) {
    const bodyPageId = nonEmptyString(
      (parsedBody as Record<string, unknown>)["pageId"]
    );
    if (bodyPageId !== null) {
      return { pageId: bodyPageId };
    }
  }

  return { pageId: null };
}

/**
 * Derive the Data_Store storage key for a resolved target.
 *
 * The mapping is deterministic and injective (Requirements 4.5, 4.6):
 * - The same Page_Id always yields the same key (determinism), so identical
 *   Page_Id values operate on the same Counter_Record (Requirement 4.6).
 * - Distinct Page_Id values (compared with exact, case-sensitive string
 *   equality) yield distinct keys (injectivity), so they map to separate
 *   Counter_Records (Requirement 4.5). A valid Page_Id is used verbatim as the
 *   key, so this reduces to string identity for user pages.
 * - The Global_Counter (`pageId === null`) maps to the reserved
 *   {@link GLOBAL_COUNTER_KEY}, which lies outside the Permitted_Character_Set
 *   and therefore cannot equal any valid Page_Id-derived key.
 *
 * @param pageId - The resolved Page_Id, or `null` for the Global_Counter.
 * @returns The {@link CounterKey} identifying the Counter_Record.
 */
export function deriveCounterKey(pageId: string | null): CounterKey {
  return { pageId: pageId === null ? GLOBAL_COUNTER_KEY : pageId };
}

/**
 * Maximum permitted Page_Id length, measured in Unicode code points.
 *
 * Counted via `[...pageId].length` (see {@link validatePageId}) so that a
 * character composed of a surrogate pair counts as a single code point rather
 * than two UTF-16 units (Requirement 7.2).
 */
export const MAX_PAGE_ID_CODE_POINTS = 128;

/**
 * The Permitted_Character_Set for a Page_Id: ASCII letters, ASCII digits,
 * hyphen, underscore, period, and forward slash (Requirements 7.3, 7.5). The
 * pattern is anchored and requires at least one character, so it rejects both
 * the empty string and any value containing a disallowed character.
 */
export const PERMITTED_PAGE_ID = /^[A-Za-z0-9\-_.\/]+$/;

/**
 * Maximum permitted request body size, measured in decoded bytes.
 *
 * Enforced against the byte length of the decoded body (see {@link parseBody})
 * before JSON parsing, so the limit reflects actual wire size regardless of
 * multi-byte characters (Requirement 7.6).
 */
export const MAX_BODY_BYTES = 8192;

/**
 * Validate a resolved Page_Id against the length and character-set rules.
 *
 * Behavior (Requirements 7.2–7.5):
 * - `pageId === null` (the Global_Counter target) is always valid; returns
 *   `null`.
 * - An empty string is rejected with `PAGE_ID_EMPTY` (Requirement 7.4).
 * - A value longer than {@link MAX_PAGE_ID_CODE_POINTS} code points — counted
 *   via `[...pageId].length` so surrogate pairs count as one — is rejected
 *   with `PAGE_ID_TOO_LONG` (Requirement 7.2). Length is checked before the
 *   character-set test so an over-long value reports the length error.
 * - A value containing any character outside {@link PERMITTED_PAGE_ID} is
 *   rejected with `PAGE_ID_DISALLOWED_CHARS` (Requirement 7.3).
 * - Otherwise the Page_Id is accepted; returns `null` (Requirement 7.5).
 *
 * @param pageId - The resolved Page_Id, or `null` for the Global_Counter.
 * @returns A {@link ValidationError} describing the violation, or `null` when
 *   the Page_Id is valid (or the target is the Global_Counter).
 */
/**
 * Zod schema encoding the Page_Id validation rules for a non-null Page_Id.
 *
 * The three rules are applied in a single {@link z.ZodType.superRefine} so their
 * evaluation order is guaranteed and each maps to exactly one
 * {@link ValidationError} `kind`, carried on the issue's `params.kind`:
 *
 * 1. Empty string -> `PAGE_ID_EMPTY` (Requirement 7.4).
 * 2. More than {@link MAX_PAGE_ID_CODE_POINTS} code points, counted via
 *    `[...value].length` so surrogate pairs count as one -> `PAGE_ID_TOO_LONG`
 *    (Requirement 7.2). Deliberately NOT `z.string().max()`, which counts
 *    UTF-16 code units and would miscount astral characters.
 * 3. Any character outside {@link PERMITTED_PAGE_ID} -> `PAGE_ID_DISALLOWED_CHARS`
 *    (Requirement 7.3).
 *
 * The checks short-circuit on the first failure (via early `return`) so an
 * over-length value reports the length error rather than also reporting a
 * character-set error, matching the original ordered `if` chain.
 */
const pageIdSchema = z.string().superRefine((value, ctx) => {
  if (value.length === 0) {
    ctx.addIssue({
      code: "custom",
      params: { kind: "PAGE_ID_EMPTY" satisfies ValidationError["kind"] },
    });
    return;
  }

  if ([...value].length > MAX_PAGE_ID_CODE_POINTS) {
    ctx.addIssue({
      code: "custom",
      params: { kind: "PAGE_ID_TOO_LONG" satisfies ValidationError["kind"] },
    });
    return;
  }

  if (!PERMITTED_PAGE_ID.test(value)) {
    ctx.addIssue({
      code: "custom",
      params: {
        kind: "PAGE_ID_DISALLOWED_CHARS" satisfies ValidationError["kind"],
      },
    });
  }
});

export function validatePageId(pageId: string | null): ValidationError | null {
  if (pageId === null) {
    return null;
  }

  const result = pageIdSchema.safeParse(pageId);
  if (result.success) {
    return null;
  }

  // The schema emits exactly one custom issue carrying `params.kind` (the
  // matching ValidationError kind). `params` is present only on custom issues,
  // so it is not part of the base issue union type; narrow to read it. The
  // first issue is the earliest rule that failed.
  const issue = result.error.issues[0] as
    | { params?: { kind?: ValidationError["kind"] } }
    | undefined;
  const kind = issue?.params?.kind;
  return kind ? { kind } : { kind: "PAGE_ID_DISALLOWED_CHARS" };
}

/**
 * Zod schema that parses a decoded body string into a JSON value.
 *
 * `transform` performs the parse inside a guarded block; on `JSON.parse`
 * failure it flags a custom issue so `safeParse` reports failure, which
 * {@link parseBody} maps to `INVALID_JSON` (Requirement 7.1). The parsed value
 * is intentionally typed as `unknown`: downstream target resolution inspects it
 * structurally rather than relying on a fixed shape, so no further schema is
 * imposed here. The decode and {@link MAX_BODY_BYTES} size gate run in
 * {@link parseBody} before this schema, because they concern the raw wire body
 * (base64/byte length) rather than the parsed JSON value.
 */
const jsonBodySchema = z.string().transform((text, ctx): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid JSON" });
    return z.NEVER;
  }
});

/**
 * Decode and parse a request body into a JSON value.
 *
 * Processing order (Requirements 7.1, 7.6):
 * 1. Decode the raw body to bytes. When `isBase64Encoded` is true the body is
 *    a base64 string (API Gateway HTTP API v2 sets this for binary payloads);
 *    otherwise it is treated as UTF-8 text.
 * 2. Enforce the {@link MAX_BODY_BYTES} cap against the decoded byte length via
 *    `Buffer.byteLength`, before any JSON parsing, so the limit measures actual
 *    body size (Requirement 7.6). An over-size body returns `BODY_TOO_LARGE`.
 * 3. Parse the decoded text as JSON. Invalid JSON returns `INVALID_JSON`
 *    (Requirement 7.1).
 *
 * An empty or absent body (`undefined`, empty string, or a base64 value that
 * decodes to zero bytes) is treated as "no body": it is neither an error nor a
 * parsed value, and is reported as `{ parsed: undefined }`.
 *
 * @param rawBody - The raw request body string, or `undefined` when absent.
 * @param isBase64Encoded - Whether `rawBody` is base64-encoded.
 * @returns `{ parsed }` on success (with `parsed === undefined` for no body),
 *   or `{ error }` describing the first violation encountered.
 */
export function parseBody(
  rawBody: string | undefined,
  isBase64Encoded: boolean
): { parsed: unknown } | { error: ValidationError } {
  if (rawBody === undefined || rawBody.length === 0) {
    return { parsed: undefined };
  }

  const decoded = isBase64Encoded
    ? Buffer.from(rawBody, "base64").toString("utf8")
    : rawBody;

  if (decoded.length === 0) {
    return { parsed: undefined };
  }

  if (Buffer.byteLength(decoded, "utf8") > MAX_BODY_BYTES) {
    return { error: { kind: "BODY_TOO_LARGE" } };
  }

  const jsonResult = jsonBodySchema.safeParse(decoded);
  if (!jsonResult.success) {
    return { error: { kind: "INVALID_JSON" } };
  }
  return { parsed: jsonResult.data };
}
