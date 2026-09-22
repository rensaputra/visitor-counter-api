/**
 * Property-based tests for the input module: target resolution and storage-key
 * derivation.
 *
 * Covers Properties 6–9 from the design document, exercising
 * {@link resolveTarget}, {@link deriveCounterKey}, and {@link GLOBAL_COUNTER_KEY}.
 */

import fc from "fast-check";
import { resolveTarget, deriveCounterKey, GLOBAL_COUNTER_KEY } from "./input";

/**
 * A non-empty string usable as a `page` query parameter or `pageId` body
 * value. We avoid the empty string because the "non-empty" precedence rules
 * treat empty strings as absent.
 */
const nonEmptyStringArb = fc.string({ minLength: 1 });

/**
 * An arbitrary body-`pageId` field value that may be present or absent, and
 * when present may be any type (string, number, null, object, ...). Used to
 * show that the query parameter wins regardless of what the body contains.
 */
const anyBodyPageIdArb: fc.Arbitrary<Record<string, unknown> | undefined> =
  fc.oneof(
    fc.constant<undefined>(undefined),
    fc.record({ pageId: nonEmptyStringArb }),
    fc.record({ pageId: fc.constant("") }),
    fc.record({ pageId: fc.integer() }),
    fc.record({ pageId: fc.constant(null) }),
    fc.record({ other: nonEmptyStringArb }),
    fc.object(),
  );

describe("resolveTarget", () => {
  // Feature: visitor-counter-api, Property 6: Query parameter takes precedence in target resolution
  it("selects the non-empty page query value regardless of the body pageId", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        anyBodyPageIdArb,
        fc.dictionary(fc.string(), fc.string()),
        (pageQuery, body, extraParams) => {
          const query = { ...extraParams, page: pageQuery };
          const result = resolveTarget(query, body);
          expect(result.pageId).toBe(pageQuery);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 7: Body pageId used when query parameter is absent or empty
  it("selects the non-empty body pageId when the page query parameter is absent or empty", () => {
    // Query state with no non-empty `page`: either undefined, absent key, or empty string.
    const queryWithoutPageArb: fc.Arbitrary<
      Record<string, string> | undefined
    > = fc.oneof(
      fc.constant<undefined>(undefined),
      fc.dictionary(
        fc.string().filter((k) => k !== "page"),
        fc.string(),
      ),
      fc
        .dictionary(
          fc.string().filter((k) => k !== "page"),
          fc.string(),
        )
        .map((d) => ({ ...d, page: "" })),
    );

    fc.assert(
      fc.property(
        nonEmptyStringArb,
        queryWithoutPageArb,
        (bodyPageId, query) => {
          const result = resolveTarget(query, { pageId: bodyPageId });
          expect(result.pageId).toBe(bodyPageId);
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 8: Absence of both selectors resolves to the Global_Counter
  it("resolves to the Global_Counter (pageId: null) when neither selector is supplied", () => {
    // `page` is absent or empty.
    const queryNoPageArb: fc.Arbitrary<Record<string, string> | undefined> =
      fc.oneof(
        fc.constant<undefined>(undefined),
        fc.dictionary(
          fc.string().filter((k) => k !== "page"),
          fc.string(),
        ),
        fc
          .dictionary(
            fc.string().filter((k) => k !== "page"),
            fc.string(),
          )
          .map((d) => ({ ...d, page: "" })),
      );

    // Body supplies no non-empty `pageId`: absent, empty, non-string, or non-object.
    const bodyNoPageIdArb: fc.Arbitrary<unknown> = fc.oneof(
      fc.constant<undefined>(undefined),
      fc.constant<null>(null),
      fc.constant(""),
      fc.integer(),
      fc.boolean(),
      fc.record({ pageId: fc.constant("") }),
      fc.record({ pageId: fc.constant(null) }),
      fc.record({ pageId: fc.integer() }),
      fc.record({ other: fc.string() }),
      fc.object().filter(
        (o) =>
          !(
            typeof (o as Record<string, unknown>)["pageId"] === "string" &&
            ((o as Record<string, unknown>)["pageId"] as string).length > 0
          ),
      ),
    );

    fc.assert(
      fc.property(queryNoPageArb, bodyNoPageIdArb, (query, body) => {
        const result = resolveTarget(query, body);
        expect(result.pageId).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});

describe("deriveCounterKey", () => {
  // Feature: visitor-counter-api, Property 9: Page_Id key derivation is deterministic and injective
  it("is deterministic: the same Page_Id always yields the same key", () => {
    fc.assert(
      fc.property(fc.oneof(nonEmptyStringArb, fc.constant(null)), (pageId) => {
        expect(deriveCounterKey(pageId)).toEqual(deriveCounterKey(pageId));
      }),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 9: Page_Id key derivation is deterministic and injective
  it("is injective: Page_Ids that differ under case-sensitive comparison yield distinct keys", () => {
    fc.assert(
      fc.property(nonEmptyStringArb, nonEmptyStringArb, (a, b) => {
        fc.pre(a !== b);
        expect(deriveCounterKey(a).pageId).not.toBe(deriveCounterKey(b).pageId);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: visitor-counter-api, Property 9: Page_Id key derivation is deterministic and injective
  it("derives GLOBAL_COUNTER_KEY for the Global_Counter and never collides with a valid Page_Id", () => {
    // A valid Page_Id is drawn only from the Permitted_Character_Set; the
    // reserved global key contains characters outside that set, so no valid
    // Page_Id can derive the same key.
    const validPageIdArb = fc
      .stringMatching(/^[A-Za-z0-9\-_.\/]+$/)
      .filter((s) => [...s].length >= 1 && [...s].length <= 128);

    // Global_Counter derives the reserved key.
    expect(deriveCounterKey(null).pageId).toBe(GLOBAL_COUNTER_KEY);

    fc.assert(
      fc.property(validPageIdArb, (pageId) => {
        expect(deriveCounterKey(pageId).pageId).not.toBe(GLOBAL_COUNTER_KEY);
      }),
      { numRuns: 200 },
    );
  });
});

/**
 * Property-based tests for the input module's validation and body-parsing
 * layer: {@link validatePageId} and {@link parseBody}.
 *
 * Covers Properties 13–17 from the design document, exercising the length,
 * character-set, JSON-validity, and body-size rules (Requirements 7.1–7.6).
 */

import {
  validatePageId,
  parseBody,
  MAX_PAGE_ID_CODE_POINTS,
  PERMITTED_PAGE_ID,
  MAX_BODY_BYTES,
} from "./input";

describe("parseBody - malformed JSON", () => {
  // Feature: visitor-counter-api, Property 13: Malformed JSON bodies are rejected
  it("returns INVALID_JSON for any non-empty body that is not valid JSON", () => {
    // Generate arbitrary strings, then keep only those that are (a) non-empty
    // once decoded and (b) not accidentally valid JSON. This restricts the
    // input space to genuinely malformed, non-empty bodies. The size cap is
    // never triggered here, so the only possible failure is INVALID_JSON.
    const malformedJsonArb = fc
      .string()
      .filter((s) => {
        if (s.length === 0) return false;
        // Exclude bodies whose byte length would trip the size cap first, so
        // this property isolates the JSON-parse failure path.
        if (Buffer.byteLength(s, "utf8") > MAX_BODY_BYTES) return false;
        try {
          JSON.parse(s);
          return false; // parseable => not malformed, exclude it
        } catch {
          return true; // not parseable => genuinely malformed
        }
      });

    fc.assert(
      fc.property(malformedJsonArb, (body) => {
        const result = parseBody(body, false);
        expect(result).toEqual({ error: { kind: "INVALID_JSON" } });
      }),
      { numRuns: 200 },
    );
  });
});

describe("validatePageId - over-length", () => {
  // Feature: visitor-counter-api, Property 14: Over-length Page_Id is rejected
  it("returns PAGE_ID_TOO_LONG for any Page_Id exceeding 128 code points", () => {
    // Build over-length Page_Ids from a mix of single-code-point ASCII
    // characters and multi-code-unit (surrogate-pair) characters, so the test
    // exercises code-point counting rather than UTF-16 unit counting. Using
    // only Permitted_Character_Set members for the ASCII portion is not
    // required here (length is checked before the character set), but mixing
    // in astral characters ensures surrogate pairs each count as exactly one
    // code point.
    //
    // A code-point array of length > MAX_PAGE_ID_CODE_POINTS must be rejected
    // for length regardless of its characters, since the length check runs
    // before the character-set check.
    const codePointArb = fc.oneof(
      // ASCII permitted character.
      fc.constantFrom(..."abcXYZ0129-_./".split("")),
      // Astral (surrogate-pair) code points: emoji / supplementary plane.
      fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) =>
        String.fromCodePoint(cp),
      ),
    );

    const overLengthArb = fc
      .array(codePointArb, {
        minLength: MAX_PAGE_ID_CODE_POINTS + 1,
        maxLength: MAX_PAGE_ID_CODE_POINTS + 40,
      })
      .map((chars) => chars.join(""));

    fc.assert(
      fc.property(overLengthArb, (pageId) => {
        // Precondition sanity: the code-point length truly exceeds the max
        // even though the UTF-16 .length may be larger.
        fc.pre([...pageId].length > MAX_PAGE_ID_CODE_POINTS);
        const result = validatePageId(pageId);
        expect(result).toEqual({ kind: "PAGE_ID_TOO_LONG" });
      }),
      { numRuns: 200 },
    );
  });
});

describe("validatePageId - disallowed characters", () => {
  // Feature: visitor-counter-api, Property 15: Disallowed characters in Page_Id are rejected
  it("returns PAGE_ID_DISALLOWED_CHARS for a 1-128 code point Page_Id containing a disallowed char", () => {
    // A permitted-character segment (possibly empty) plus at least one
    // guaranteed-disallowed character, kept within the 1-128 code point bound
    // so the length check passes and the character-set check is what rejects.
    const permittedSegmentArb = fc
      .stringMatching(/^[A-Za-z0-9\-_.\/]*$/)
      .filter((s) => [...s].length <= 100);

    // Characters known to be outside the Permitted_Character_Set, including a
    // surrogate-pair (astral) code point to exercise multi-unit handling.
    const disallowedCharArb = fc.oneof(
      fc.constantFrom(..."!@#$%^&*()+= {}[]|\\:;\"'<>,?~`".split("")),
      fc.constantFrom(" ", "\t", "\n"),
      fc.constantFrom("é", "ü", "ñ", "λ", "Ω", "字", "🚀", "😀"),
    );

    fc.assert(
      fc.property(
        permittedSegmentArb,
        disallowedCharArb,
        // Where to splice the disallowed character within the segment.
        fc.double({ min: 0, max: 1, noNaN: true }),
        (segment, badChar, position) => {
          const seg = [...segment];
          const idx = Math.floor(position * (seg.length + 1));
          const chars = [...seg.slice(0, idx), badChar, ...seg.slice(idx)];
          const pageId = chars.join("");

          // Keep within 1-128 code points so length is not the reason for
          // rejection.
          const cpLen = [...pageId].length;
          fc.pre(cpLen >= 1 && cpLen <= MAX_PAGE_ID_CODE_POINTS);
          // Sanity: the value really does contain a disallowed character.
          fc.pre(!PERMITTED_PAGE_ID.test(pageId));

          const result = validatePageId(pageId);
          expect(result).toEqual({ kind: "PAGE_ID_DISALLOWED_CHARS" });
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("validatePageId - valid Page_Id", () => {
  // Feature: visitor-counter-api, Property 16: Valid Page_Id is accepted
  it("returns null for a 1-128 code point Page_Id containing only permitted characters", () => {
    // Draw only from the Permitted_Character_Set and constrain the code-point
    // length to the inclusive 1-128 range. Such values must be accepted.
    const validPageIdArb = fc
      .stringMatching(/^[A-Za-z0-9\-_.\/]+$/)
      .filter((s) => {
        const len = [...s].length;
        return len >= 1 && len <= MAX_PAGE_ID_CODE_POINTS;
      });

    fc.assert(
      fc.property(validPageIdArb, (pageId) => {
        expect(validatePageId(pageId)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});

describe("parseBody - over-size body", () => {
  // Feature: visitor-counter-api, Property 17: Over-size request bodies are rejected before parsing
  it("returns BODY_TOO_LARGE for any body whose decoded byte length exceeds 8192 bytes", () => {
    // Build bodies from a mix of ASCII (1 byte) and multi-byte UTF-8
    // characters so the byte length diverges from the code-point/UTF-16 length,
    // exercising the Buffer.byteLength check. Even valid-JSON-looking oversize
    // bodies must be rejected before parsing, so we don't constrain content to
    // malformed JSON — the size gate runs first.
    const chunkArb = fc.oneof(
      fc.constantFrom("a", "Z", "0", "/"), // 1 byte each
      fc.constantFrom("é", "ü", "ñ"), // 2 bytes each in UTF-8
      fc.constantFrom("字", "€", "λ"), // 3 bytes each in UTF-8
      fc.constantFrom("🚀", "😀"), // 4 bytes each in UTF-8
    );

    const overSizeArb = fc
      .array(chunkArb, { minLength: 1, maxLength: 4000 })
      .map((chunks) => {
        let body = chunks.join("");
        // Pad with single-byte characters until the byte length definitively
        // exceeds the cap, guaranteeing the over-size condition.
        while (Buffer.byteLength(body, "utf8") <= MAX_BODY_BYTES) {
          body += "a".repeat(256);
        }
        return body;
      });

    fc.assert(
      fc.property(overSizeArb, (body) => {
        // Confirm the generated body truly exceeds the byte cap.
        fc.pre(Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES);
        const result = parseBody(body, false);
        expect(result).toEqual({ error: { kind: "BODY_TOO_LARGE" } });
      }),
      { numRuns: 200 },
    );
  });
});

describe("validatePageId - Global_Counter target (example test)", () => {
  // Covers the `pageId === null` early-return branch: the Global_Counter target
  // is always valid and yields `null` (Requirement 7).
  it("returns null for a null Page_Id (Global_Counter)", () => {
    expect(validatePageId(null)).toBeNull();
  });
});

describe("parseBody - base64-encoded bodies (example tests)", () => {
  // Covers the base64 decode branch: a base64-encoded JSON body is decoded to
  // UTF-8 and parsed successfully.
  it("decodes and parses a base64-encoded JSON body", () => {
    const json = JSON.stringify({ pageId: "abc" });
    const base64 = Buffer.from(json, "utf8").toString("base64");

    const result = parseBody(base64, true);

    expect(result).toEqual({ parsed: { pageId: "abc" } });
  });

  // Covers the `decoded.length === 0` branch: a non-empty base64 string that
  // decodes to zero bytes is treated as "no body" (parsed: undefined).
  it("treats a base64 body that decodes to empty as no body", () => {
    // "====" is a non-empty raw string that base64-decodes to an empty string,
    // so it passes the raw-empty guard but hits the decoded-empty branch.
    const result = parseBody("====", true);

    expect(result).toEqual({ parsed: undefined });
  });
});
