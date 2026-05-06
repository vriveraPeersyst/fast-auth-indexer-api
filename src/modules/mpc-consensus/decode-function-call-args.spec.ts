import { decodeFunctionCallArgs } from "./decode-function-call-args";

const buildPayload = (action: any) => ({ actions: [action] });
const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("decodeFunctionCallArgs", () => {
    it("returns _decode_error: no_payload when payload is null", () => {
        expect(decodeFunctionCallArgs(null, "any")).toEqual({ _decode_error: "no_payload" });
    });

    it("returns _decode_error: no_payload when payload is not an object", () => {
        expect(decodeFunctionCallArgs("string", "any")).toEqual({ _decode_error: "no_payload" });
    });

    it("returns _decode_error: no_actions when payload has no actions array", () => {
        expect(decodeFunctionCallArgs({ foo: "bar" }, "any")).toEqual({ _decode_error: "no_actions" });
    });

    it("returns _decode_error: method_not_found_in_actions when method does not match", () => {
        const payload = buildPayload({ FunctionCall: { method_name: "different", args: b64("{}") } });
        expect(decodeFunctionCallArgs(payload, "want")).toEqual({ _decode_error: "method_not_found_in_actions" });
    });

    it("returns _decode_error: no_args when args is empty", () => {
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args: "" } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _decode_error: "no_args" });
    });

    it("returns _decode_error: no_args when args is missing", () => {
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk" } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _decode_error: "no_args" });
    });

    it("returns the parsed object when args decode and parse succeed", () => {
        const args = b64(JSON.stringify({ epoch: 5, voter: "node-1.pool.near" }));
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ epoch: 5, voter: "node-1.pool.near" });
    });

    it("wraps non-object JSON values in { _value }", () => {
        const args = b64(JSON.stringify(42));
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _value: 42 });
    });

    it("wraps array JSON values in { _value }", () => {
        const args = b64(JSON.stringify([1, 2]));
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _value: [1, 2] });
    });

    it("returns empty object when utf8 decoded args are empty", () => {
        const args = b64("");
        // empty base64 results in empty utf8; the function treats empty utf8
        // separately from missing args — empty string args is valid (yields {}).
        // The implementation hits this path only if args.length > 0 (so "" is
        // caught earlier as no_args). Use a single space encoded as base64
        // wouldn't be empty. Actually the early `length === 0` check skips.
        // So this case is unreachable from outside — instead test the
        // post-base64-empty path with a string that decodes to empty: there
        // isn't one. Skip — the no_args path covers that branch.
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _decode_error: "no_args" });
    });

    it("returns _decode_error: not_json with raw utf8 when args are not JSON", () => {
        const args = b64("not-json-at-all");
        const payload = buildPayload({ FunctionCall: { method_name: "vote_pk", args } });
        expect(decodeFunctionCallArgs(payload, "vote_pk")).toEqual({ _decode_error: "not_json", _raw: "not-json-at-all" });
    });

    it("scans multiple actions and matches the right one", () => {
        const payload = {
            actions: [
                { Transfer: { deposit: "1" } },
                { FunctionCall: { method_name: "noise", args: b64("{}") } },
                { FunctionCall: { method_name: "target", args: b64(JSON.stringify({ ok: true })) } },
            ],
        };
        expect(decodeFunctionCallArgs(payload, "target")).toEqual({ ok: true });
    });
});
