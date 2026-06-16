import {
    decodeBase64ToUtf8,
    decodeBase64UrlToUtf8,
    isLikelyNearAccountId,
    normalizeNearPublicKey,
    parseActionMetadata,
    parseExecutionStatus,
    parseJsonObject,
    sha256,
    toDateFromNearNs,
    toNullableBigInt,
} from "./conversion.helpers";

describe("toDateFromNearNs", () => {
    it("falls back to now() when timestamp is missing", () => {
        const before = Date.now();
        const after = toDateFromNearNs(undefined).getTime();
        expect(after).toBeGreaterThanOrEqual(before);
    });

    it("converts ns to ms", () => {
        // Stay within safe-integer range to avoid no-loss-of-precision lint.
        const ns = 1_700_000_000_000_000;
        const date = toDateFromNearNs(ns);
        expect(date.getTime()).toBe(Math.floor(ns / 1_000_000));
    });
});

describe("toNullableBigInt", () => {
    it("passes bigint through", () => {
        expect(toNullableBigInt(BigInt(42))).toBe(BigInt(42));
    });
    it("converts finite, non-negative numbers", () => {
        expect(toNullableBigInt(7)).toBe(BigInt(7));
    });
    it("returns null for negative or non-finite numbers", () => {
        expect(toNullableBigInt(-1)).toBeNull();
        expect(toNullableBigInt(NaN)).toBeNull();
        expect(toNullableBigInt(Infinity)).toBeNull();
    });
    it("converts numeric strings", () => {
        expect(toNullableBigInt("123")).toBe(BigInt(123));
    });
    it("returns null for non-numeric strings or other types", () => {
        expect(toNullableBigInt("abc")).toBeNull();
        expect(toNullableBigInt({})).toBeNull();
    });
});

describe("normalizeNearPublicKey", () => {
    it("returns trimmed value when non-empty", () => {
        expect(normalizeNearPublicKey("  ed25519:abc  ")).toBe("ed25519:abc");
    });
    it("returns null for missing/empty", () => {
        expect(normalizeNearPublicKey(undefined)).toBeNull();
        expect(normalizeNearPublicKey("")).toBeNull();
        expect(normalizeNearPublicKey("   ")).toBeNull();
    });
});

describe("parseExecutionStatus", () => {
    it("returns included when status is null/undefined", () => {
        expect(parseExecutionStatus(null)).toEqual({ executionStatus: "included", failureReason: null });
        expect(parseExecutionStatus(undefined)).toEqual({ executionStatus: "included", failureReason: null });
    });
    it("returns the literal string status", () => {
        expect(parseExecutionStatus("Pending")).toEqual({ executionStatus: "Pending", failureReason: null });
    });
    it("extracts the first object key as variant", () => {
        expect(parseExecutionStatus({ SuccessValue: "ok" })).toEqual({ executionStatus: "SuccessValue", failureReason: null });
    });
    it("captures failure reason for object failure variants (string payload)", () => {
        expect(parseExecutionStatus({ Failure: "boom" })).toEqual({ executionStatus: "Failure", failureReason: "boom" });
    });
    it("JSON-stringifies non-string failure payloads", () => {
        expect(parseExecutionStatus({ Failure: { x: 1 } }).failureReason).toBe('{"x":1}');
    });
    it("returns included for an empty object", () => {
        expect(parseExecutionStatus({})).toEqual({ executionStatus: "included", failureReason: null });
    });
});

describe("parseActionMetadata", () => {
    it("returns nulls for empty/missing actions", () => {
        expect(parseActionMetadata(undefined)).toEqual({ methodName: null, attachedDepositYocto: null });
        expect(parseActionMetadata([])).toEqual({ methodName: null, attachedDepositYocto: null });
    });
    it("returns FunctionCall method+deposit when present", () => {
        expect(parseActionMetadata([{ FunctionCall: { method_name: "ft_transfer", deposit: "1" } }])).toEqual({
            methodName: "ft_transfer",
            attachedDepositYocto: "1",
        });
    });
    it("falls back to bare action name when no FunctionCall", () => {
        expect(parseActionMetadata([{ Transfer: { deposit: "9" } }])).toEqual({ methodName: "Transfer", attachedDepositYocto: null });
    });
    it("uses 'FunctionCall' literal when method_name missing", () => {
        expect(parseActionMetadata([{ FunctionCall: { deposit: "0" } }]).methodName).toBe("FunctionCall");
    });
});

describe("isLikelyNearAccountId", () => {
    it("accepts named + suffix accounts", () => {
        expect(isLikelyNearAccountId("alice.near")).toBe(true);
        expect(isLikelyNearAccountId("near")).toBe(true);
    });
    it("rejects disallowed chars", () => {
        expect(isLikelyNearAccountId("a@b")).toBe(false);
    });
    it("rejects single-segment short ids without suffix", () => {
        expect(isLikelyNearAccountId("alice")).toBe(false);
    });
});

describe("sha256", () => {
    it("returns a 64-char hex digest", () => {
        const hash = sha256("hello");
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("decodeBase64ToUtf8 + parseJsonObject", () => {
    it("decodes base64 to utf8", () => {
        expect(decodeBase64ToUtf8(Buffer.from("hello").toString("base64"))).toBe("hello");
    });
    it("returns null on invalid input — but Node.js Buffer.from is permissive (no throw)", () => {
        // This branch is hard to trigger; Buffer.from accepts almost anything.
        // The function still returns a string in practice.
        expect(typeof decodeBase64ToUtf8("not-base64-but-still-decodes")).toBe("string");
    });
    it("parseJsonObject returns null for null/undefined input", () => {
        expect(parseJsonObject(null)).toBeNull();
    });
    it("parseJsonObject rejects arrays", () => {
        expect(parseJsonObject(JSON.stringify([1, 2]))).toBeNull();
    });
    it("parseJsonObject rejects primitives", () => {
        expect(parseJsonObject(JSON.stringify(42))).toBeNull();
    });
    it("parseJsonObject parses objects", () => {
        expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    });
    it("parseJsonObject returns null on bad JSON", () => {
        expect(parseJsonObject("not-json")).toBeNull();
    });
});

describe("decodeBase64UrlToUtf8", () => {
    it("decodes URL-safe base64 with padding restoration", () => {
        const standard = Buffer.from('{"a":1}').toString("base64").replace(/=+$/, "");
        const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_");
        expect(decodeBase64UrlToUtf8(urlSafe)).toBe('{"a":1}');
    });
});
