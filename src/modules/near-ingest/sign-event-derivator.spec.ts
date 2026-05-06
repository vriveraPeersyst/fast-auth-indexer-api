import { deriveFastAuthSignEvents, resolveProviderType, toMpcDomainId } from "./sign-event-derivator";

const FA = new Set(["fast-auth.near"]);

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("resolveProviderType", () => {
    it("returns unknown for empty/whitespace", () => {
        expect(resolveProviderType(null)).toEqual({ providerType: "unknown", guardName: null });
        expect(resolveProviderType("  ")).toEqual({ providerType: "unknown", guardName: null });
    });

    it("classifies auth0 / firebase / custom_issuer literal names", () => {
        expect(resolveProviderType("jwt#auth0").providerType).toBe("auth0");
        expect(resolveProviderType("jwt#firebase").providerType).toBe("firebase");
        expect(resolveProviderType("jwt#custom").providerType).toBe("custom_issuer");
        expect(resolveProviderType("jwt#issuer-x").providerType).toBe("custom_issuer");
    });

    it("classifies known IdP hosts in URL form", () => {
        expect(resolveProviderType("jwt#https://example.auth0.com/").providerType).toBe("auth0");
        expect(resolveProviderType("jwt#https://securetoken.google.com/myapp").providerType).toBe("firebase");
    });

    it("falls back to custom_issuer for unknown URL hosts", () => {
        expect(resolveProviderType("jwt#https://my.idp.example/").providerType).toBe("custom_issuer");
    });

    it("falls back to custom_issuer for malformed URL hosts", () => {
        expect(resolveProviderType("jwt#https://").providerType).toBe("custom_issuer");
    });

    it("returns unknown for non-URL non-keyword guard names", () => {
        expect(resolveProviderType("plain-name").providerType).toBe("unknown");
    });
});

describe("toMpcDomainId", () => {
    it("returns 1 for eddsa, 0 for secp256k1/ecdsa, null for others", () => {
        expect(toMpcDomainId("eddsa")).toBe(1);
        expect(toMpcDomainId("EDDSA")).toBe(1);
        expect(toMpcDomainId("secp256k1")).toBe(0);
        expect(toMpcDomainId("ecdsa")).toBe(0);
        expect(toMpcDomainId("rsa")).toBeNull();
        expect(toMpcDomainId(null)).toBeNull();
        expect(toMpcDomainId("  ")).toBeNull();
    });
});

describe("deriveFastAuthSignEvents", () => {
    const baseParams = {
        blockHeight: 100,
        blockTimestamp: 1_700_000_000_000_000,
        executionStatus: "SUCCESS_VALUE",
        failureReason: null as string | null,
        gasBurnt: BigInt(1000),
        relayerPublicKey: "ed25519:relayer-key",
        fastAuthContractSet: FA,
    };

    it("returns empty seeds when receiver isn't in FA contract set", () => {
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "other.near",
                actions: [{ FunctionCall: { method_name: "sign", args: b64("{}") } }],
            },
        });
        expect(result.seeds).toEqual([]);
    });

    it("returns empty seeds when txHash is missing", () => {
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: { signer_id: "relayer.near", receiver_id: "fast-auth.near", actions: [] },
        });
        expect(result.seeds).toEqual([]);
    });

    it("returns one seed per sign() FunctionCall", () => {
        const args = b64(JSON.stringify({ guard_id: "jwt#auth0", algorithm: "ecdsa", verify_payload: "a.b.c" }));
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [
                    { FunctionCall: { method_name: "noise" } }, // skipped
                    { FunctionCall: { method_name: "sign", args, deposit: "0" } },
                ],
            },
        });
        expect(result.seeds).toHaveLength(1);
        const seed = result.seeds[0];
        expect(seed).toMatchObject({
            txHash: "tx1",
            actionIndex: 1,
            relayerAccountId: "relayer.near",
            fastAuthContractId: "fast-auth.near",
            providerType: "auth0",
            algorithm: "ecdsa",
            userDomainId: 0,
        });
    });

    it("derives userKeyPath as guardId#sub when JWT has sub", () => {
        // JWT shape: header.payload.signature where payload base64url is { sub: "user-1" }
        const payload = Buffer.from(JSON.stringify({ sub: "user-1" }))
            .toString("base64")
            .replace(/=+$/, "");
        const verifyPayload = `header.${payload}.sig`;
        const args = b64(JSON.stringify({ guard_id: "jwt#auth0", algorithm: "eddsa", verify_payload: verifyPayload }));

        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].userKeyPath).toBe("jwt#auth0#user-1");
        expect(result.seeds[0].userSub).toBe("user-1");
    });

    it("skips non-FunctionCall actions", () => {
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ Transfer: { deposit: "1" } }],
            },
        });
        expect(result.seeds).toEqual([]);
    });

    it("captures inline public keys from sign_payload bytes", () => {
        // We can't easily construct a valid NEP-366 payload without borsh,
        // but a non-DelegateAction discriminant returns "Raw" from
        // decodeSignActionType and null from decodeSignDelegatePublicKey.
        // The test verifies the code path runs without crashing on a
        // numeric-array sign_payload.
        const args = b64(
            JSON.stringify({
                guard_id: "jwt#auth0",
                algorithm: "ecdsa",
                sign_payload: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            }),
        );

        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].signActionType).toBe("Raw");
    });

    it("uses signPayload as direct object when arg shape is object", () => {
        const args = b64(
            JSON.stringify({
                guard_id: "jwt#auth0",
                sign_payload: { transaction: { receiver_id: "Dapp.NEAR", signer_id: "alice.near" } },
            }),
        );

        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0]).toMatchObject({
            projectDappId: "dapp.near",
            sponsoredAccountId: "alice.near",
        });
    });

    it("decodes sign_payload from base64-encoded string", () => {
        const inner = JSON.stringify({ transaction: { receiver_id: "fancy.near" } });
        const encoded = Buffer.from(inner).toString("base64");
        const args = b64(JSON.stringify({ guard_id: "jwt#firebase", sign_payload: encoded }));

        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].projectDappId).toBe("fancy.near");
    });

    it("returns null userKeyPath when JWT has no sub or fewer than 2 segments", () => {
        const argsNoSub = b64(JSON.stringify({ guard_id: "jwt#auth0", verify_payload: "header.eyJub3N1YiI6dHJ1ZX0.sig" }));
        const r1 = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args: argsNoSub } }],
            },
        });
        expect(r1.seeds[0].userKeyPath).toBeNull();

        const argsBadJwt = b64(JSON.stringify({ guard_id: "jwt#auth0", verify_payload: "single-segment" }));
        const r2 = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args: argsBadJwt } }],
            },
        });
        expect(r2.seeds[0].userKeyPath).toBeNull();
    });

    it("returns null sponsoredAccountId when candidate doesn't look like a NEAR account id", () => {
        const args = b64(
            JSON.stringify({
                guard_id: "jwt#auth0",
                verify_payload: `header.${Buffer.from(JSON.stringify({ sub: "user@example.com" }))
                    .toString("base64")
                    .replace(/=+$/, "")}.sig`,
            }),
        );
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].sponsoredAccountId).toBeNull();
        expect(result.seeds[0].sponsoredAccountHash).not.toBeNull();
    });

    it("uses guardId.guardId field (camelCase) when present", () => {
        const args = b64(JSON.stringify({ guardId: "jwt#firebase" }));
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].providerType).toBe("firebase");
    });

    it("treats sign_payload as raw json when array is not all numbers", () => {
        const args = b64(JSON.stringify({ guard_id: "jwt#auth0", sign_payload: ["not", "numbers"] }));
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        // signPayloadJson preserves the original (non-numeric) array.
        expect(Array.isArray(result.seeds[0].signPayloadJson)).toBe(true);
    });

    it("falls through extractSponsoredAccount paths when no candidate matches", () => {
        const args = b64(JSON.stringify({ guard_id: "jwt#auth0", sign_payload: { unrelated: 1 } }));
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].sponsoredAccountId).toBeNull();
        expect(result.seeds[0].sponsoredAccountHash).toBeNull();
    });

    it("uses signPayload field (camelCase) and verifyPayload field", () => {
        const args = b64(
            JSON.stringify({ guard_id: "jwt#auth0", signPayload: { receiver: "x.near" }, verifyPayload: "h.eyJzdWIiOiJ1In0.s" }),
        );
        const result = deriveFastAuthSignEvents({
            ...baseParams,
            tx: {
                hash: "tx1",
                signer_id: "relayer.near",
                receiver_id: "fast-auth.near",
                actions: [{ FunctionCall: { method_name: "sign", args } }],
            },
        });
        expect(result.seeds[0].projectDappId).toBe("x.near");
        expect(result.seeds[0].userSub).toBe("u");
    });
});
