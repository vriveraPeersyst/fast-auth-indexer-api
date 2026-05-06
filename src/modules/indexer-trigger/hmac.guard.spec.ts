import { ConfigService } from "@nestjs/config";
import { ExecutionContext } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { createHmac } from "node:crypto";

import { HmacGuard } from "./hmac.guard";

const SECRET = "test-secret";

function makeContext(headers: Record<string, string>, path = "/api/indexers/run", remoteAddress = "1.2.3.4"): ExecutionContext {
    return {
        switchToHttp: () => ({
            getRequest: () => ({ headers, path, socket: { remoteAddress } }),
        }),
    } as unknown as ExecutionContext;
}

function signFor(ts: number, path: string, secret = SECRET): string {
    return createHmac("sha256", secret).update(`${ts}:${path}`).digest("hex");
}

describe("HmacGuard", () => {
    let guard: HmacGuard;

    async function build(values: Record<string, any> = { "indexer.cronSecret": SECRET, "indexer.allowedIps": [] }): Promise<void> {
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [HmacGuard, { provide: ConfigService, useValue: { get: jest.fn((k: string) => values[k]) } }],
        }).compile();
        guard = moduleRef.get(HmacGuard);
    }

    beforeEach(async () => {
        await build();
    });

    it("rejects when no secret is configured", async () => {
        await build({ "indexer.cronSecret": "", "indexer.allowedIps": [] });
        const ctx = makeContext({});
        expect(() => guard.canActivate(ctx)).toThrow(/INDEXER_TRIGGER_UNAUTHORIZED/);
    });

    it("rejects when timestamp is missing or out of skew window", async () => {
        const ctx = makeContext({ "x-timestamp": String(Date.now() - 10 * 60 * 1000), "x-signature": "any" });
        expect(() => guard.canActivate(ctx)).toThrow(/INDEXER_TRIGGER_REPLAY/);
    });

    it("rejects when timestamp is non-numeric", async () => {
        const ctx = makeContext({ "x-timestamp": "abc", "x-signature": "any" });
        expect(() => guard.canActivate(ctx)).toThrow(/INDEXER_TRIGGER_REPLAY/);
    });

    it("rejects when signature is wrong", async () => {
        const ts = Date.now();
        const ctx = makeContext({ "x-timestamp": String(ts), "x-signature": "0".repeat(64) });
        expect(() => guard.canActivate(ctx)).toThrow(/INDEXER_TRIGGER_UNAUTHORIZED/);
    });

    it("accepts a valid signature", async () => {
        const ts = Date.now();
        const path = "/api/indexers/run";
        const sig = signFor(ts, path);
        const ctx = makeContext({ "x-timestamp": String(ts), "x-signature": sig }, path);
        expect(guard.canActivate(ctx)).toBe(true);
    });

    it("rejects when source IP is not in allowlist", async () => {
        await build({ "indexer.cronSecret": SECRET, "indexer.allowedIps": ["9.9.9.9"] });
        const ts = Date.now();
        const sig = signFor(ts, "/api/indexers/run");
        const ctx = makeContext({ "x-timestamp": String(ts), "x-signature": sig }, "/api/indexers/run", "1.2.3.4");
        expect(() => guard.canActivate(ctx)).toThrow(/INDEXER_TRIGGER_FORBIDDEN_IP/);
    });

    it("uses the first IP from x-forwarded-for when multiple are present", async () => {
        await build({ "indexer.cronSecret": SECRET, "indexer.allowedIps": ["1.2.3.4"] });
        const ts = Date.now();
        const sig = signFor(ts, "/api/indexers/run");
        const ctx = makeContext(
            { "x-timestamp": String(ts), "x-signature": sig, "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
            "/api/indexers/run",
            "internal",
        );
        expect(guard.canActivate(ctx)).toBe(true);
    });
});
