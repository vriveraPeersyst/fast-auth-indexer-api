import { extractFailureReason, isFailureStatus } from "./health-status.helpers";

describe("isFailureStatus", () => {
    it("returns false for null/undefined", () => {
        expect(isFailureStatus(null)).toBe(false);
        expect(isFailureStatus(undefined)).toBe(false);
    });

    it("returns false for primitives that aren't strings", () => {
        expect(isFailureStatus(42)).toBe(false);
    });

    it("matches case-insensitive 'failure' inside string", () => {
        expect(isFailureStatus("Failure")).toBe(true);
        expect(isFailureStatus("FAILURE_STATUS")).toBe(true);
        expect(isFailureStatus("ok")).toBe(false);
    });

    it("inspects first key of object status", () => {
        expect(isFailureStatus({ Failure: {} })).toBe(true);
        expect(isFailureStatus({ SuccessValue: "abc" })).toBe(false);
    });

    it("returns false for empty objects", () => {
        expect(isFailureStatus({})).toBe(false);
    });
});

describe("extractFailureReason", () => {
    it("returns null when status is null/undefined or non-object", () => {
        expect(extractFailureReason(null)).toBeNull();
        expect(extractFailureReason(undefined)).toBeNull();
        expect(extractFailureReason("plain string")).toBeNull();
    });

    it("returns null when there is no Failure field", () => {
        expect(extractFailureReason({ SuccessValue: "x" })).toBeNull();
    });

    it("returns the literal Failure when it's a string", () => {
        expect(extractFailureReason({ Failure: "boom" })).toBe("boom");
    });

    it("extracts ActionError.kind when kind is a plain string", () => {
        expect(extractFailureReason({ Failure: { ActionError: { kind: "AccountDoesNotExist" } } })).toBe("AccountDoesNotExist");
    });

    it("extracts FunctionCallError ExecutionError message", () => {
        const status = {
            Failure: {
                ActionError: {
                    kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: assert failed" } },
                },
            },
        };
        expect(extractFailureReason(status)).toBe("Smart contract panicked: assert failed");
    });

    it("stringifies non-string FunctionCallError variants", () => {
        const status = {
            Failure: { ActionError: { kind: { FunctionCallError: { OtherVariant: { detail: "x" } } } } },
        };
        expect(extractFailureReason(status)).toBe('OtherVariant: {"detail":"x"}');
    });

    it("formats string-tagged kind variants", () => {
        const status = { Failure: { ActionError: { kind: { LackBalanceForState: "details here" } } } };
        expect(extractFailureReason(status)).toBe("LackBalanceForState: details here");
    });

    it("formats object-tagged kind variants as JSON", () => {
        const status = { Failure: { ActionError: { kind: { CustomError: { reason: "x" } } } } };
        expect(extractFailureReason(status)).toBe('CustomError: {"reason":"x"}');
    });

    it("handles InvalidTxError (string variant)", () => {
        expect(extractFailureReason({ Failure: { InvalidTxError: "Expired" } })).toBe("InvalidTxError: Expired");
    });

    it("handles InvalidTxError (object variant)", () => {
        expect(extractFailureReason({ Failure: { InvalidTxError: { NotEnoughBalance: { signer_id: "x" } } } })).toMatch(
            /InvalidTxError: \{"NotEnoughBalance"/,
        );
    });

    it("falls back to JSON.stringify on unknown failure shapes", () => {
        expect(extractFailureReason({ Failure: { Unknown: 1 } })).toBe('{"Unknown":1}');
    });
});
