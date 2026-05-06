import { extractDelegateActionInfo } from "./delegate.helpers";

const buildDelegate = (overrides: Partial<{ sender: string; receiver: string; pk: string; actions: unknown[] }> = {}) => ({
    Delegate: {
        delegate_action: {
            sender_id: overrides.sender ?? "alice.near",
            receiver_id: overrides.receiver ?? "bob.near",
            public_key: overrides.pk ?? "ed25519:user-key",
            actions: overrides.actions ?? [{ Transfer: { deposit: "1" } }],
        },
    },
});

describe("extractDelegateActionInfo", () => {
    it("returns null when actions is undefined", () => {
        expect(extractDelegateActionInfo(undefined)).toBeNull();
    });

    it("returns null when no Delegate action exists", () => {
        expect(extractDelegateActionInfo([{ Transfer: { deposit: "1" } }])).toBeNull();
    });

    it("skips entries that aren't objects", () => {
        expect(extractDelegateActionInfo([null, 5, buildDelegate()])).toMatchObject({
            innerSignerId: "alice.near",
        });
    });

    it("returns delegate info for a well-formed Delegate", () => {
        const info = extractDelegateActionInfo([buildDelegate()]);
        expect(info).toMatchObject({
            innerSignerId: "alice.near",
            innerReceiverId: "bob.near",
            innerPublicKey: "ed25519:user-key",
            innerActionTypes: ["Transfer"],
            innerMethodName: null,
        });
    });

    it("captures the first FunctionCall method_name", () => {
        const info = extractDelegateActionInfo([
            buildDelegate({ actions: [{ FunctionCall: { method_name: "ft_transfer", deposit: "0" } }] }),
        ]);
        expect(info?.innerMethodName).toBe("ft_transfer");
    });

    it("ignores Delegate with bad shape", () => {
        const bad = { Delegate: { delegate_action: { sender_id: 5, receiver_id: "b.near", public_key: "pk", actions: [] } } };
        expect(extractDelegateActionInfo([bad])).toBeNull();
    });

    it("trims sender/receiver/pk", () => {
        const info = extractDelegateActionInfo([buildDelegate({ sender: "  alice.near  ", receiver: "  bob.near  ", pk: "  pk  " })]);
        expect(info).toMatchObject({ innerSignerId: "alice.near", innerReceiverId: "bob.near", innerPublicKey: "pk" });
    });
});
