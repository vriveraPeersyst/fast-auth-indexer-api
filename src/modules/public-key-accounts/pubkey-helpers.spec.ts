import { classifyAccountType, extractAccountsFromPayload, isLikelyNearAccountId, runWithConcurrencyAbortOnError } from "./pubkey-helpers";

describe("classifyAccountType", () => {
    it("returns implicit for 64-char lowercase hex", () => {
        expect(classifyAccountType("a".repeat(64))).toBe("implicit");
        expect(classifyAccountType("0".repeat(63) + "f")).toBe("implicit");
    });

    it("returns named for everything else", () => {
        expect(classifyAccountType("alice.near")).toBe("named");
        expect(classifyAccountType("BOB")).toBe("named"); // uppercase → not implicit
        expect(classifyAccountType("a".repeat(63))).toBe("named"); // 63 chars
    });
});

describe("isLikelyNearAccountId", () => {
    it("rejects strings with disallowed chars", () => {
        expect(isLikelyNearAccountId("alice@near")).toBe(false);
        expect(isLikelyNearAccountId("space here")).toBe(false);
    });

    it("accepts named accounts (containing a dot)", () => {
        expect(isLikelyNearAccountId("alice.near")).toBe(true);
    });

    it("accepts 'near' suffix without dot", () => {
        expect(isLikelyNearAccountId("near")).toBe(true);
    });

    it("accepts implicit (64-char hex) accounts", () => {
        expect(isLikelyNearAccountId("d".repeat(64))).toBe(true);
    });

    it("rejects 64-char strings that aren't hex", () => {
        expect(isLikelyNearAccountId("z".repeat(64))).toBe(false);
    });

    it("rejects single-segment short ids without 'near' suffix", () => {
        expect(isLikelyNearAccountId("alice")).toBe(false);
    });
});

describe("extractAccountsFromPayload", () => {
    it("returns plain string array as-is", () => {
        expect(extractAccountsFromPayload(["a.near", "b.near"])).toEqual(["a.near", "b.near"]);
    });

    it("filters non-string array entries", () => {
        expect(extractAccountsFromPayload(["a.near", 5, null])).toEqual(["a.near"]);
    });

    it("returns [] when payload is null/non-object", () => {
        expect(extractAccountsFromPayload(null)).toEqual([]);
        expect(extractAccountsFromPayload("string")).toEqual([]);
    });

    it("extracts from { account_ids: [...] }", () => {
        expect(extractAccountsFromPayload({ account_ids: ["a.near"] })).toEqual(["a.near"]);
    });

    it("extracts from { accounts: [{ account_id }] } (object shape)", () => {
        expect(extractAccountsFromPayload({ accounts: [{ account_id: "a.near" }, { id: "b.near" }] })).toEqual(["a.near", "b.near"]);
    });

    it("falls through candidate keys until one yields strings", () => {
        // accountIds is empty objects (yield nothing); accounts has strings → use accounts.
        expect(extractAccountsFromPayload({ accountIds: [{}], accounts: ["a.near"] })).toEqual(["a.near"]);
    });

    it("returns [] when no candidate field has accounts", () => {
        expect(extractAccountsFromPayload({ unrelated: "x" })).toEqual([]);
    });
});

describe("runWithConcurrencyAbortOnError", () => {
    it("returns immediately on empty input", async () => {
        const worker = jest.fn();
        await runWithConcurrencyAbortOnError([], 5, worker);
        expect(worker).not.toHaveBeenCalled();
    });

    it("runs every item when no errors thrown", async () => {
        const seen: number[] = [];
        await runWithConcurrencyAbortOnError([1, 2, 3, 4], 2, async (item) => {
            seen.push(item);
        });
        expect(seen.sort()).toEqual([1, 2, 3, 4]);
    });

    it("rethrows first error and stops claiming new tasks", async () => {
        const seen: number[] = [];
        await expect(
            runWithConcurrencyAbortOnError([1, 2, 3, 4, 5], 1, async (item) => {
                seen.push(item);
                if (item === 2) throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        // After item 2 throws, runners stop claiming → at most 2 items seen
        // (item 1 + item 2). If concurrency was higher we might see one extra in-flight item.
        expect(seen.length).toBeLessThanOrEqual(2);
    });

    it("handles concurrency higher than item count", async () => {
        const seen: number[] = [];
        await runWithConcurrencyAbortOnError([1, 2], 100, async (item) => {
            seen.push(item);
        });
        expect(seen.sort()).toEqual([1, 2]);
    });
});
