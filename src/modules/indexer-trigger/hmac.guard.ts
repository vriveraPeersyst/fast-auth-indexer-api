import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";

import { BusinessException } from "../common/exception/business.exception";
import { ErrorCode } from "../common/exception/error-codes";

/** 5-minute timestamp skew window — same as the dashboard's original implementation. */
const TIMESTAMP_SKEW_WINDOW_MS = 5 * 60 * 1000;

/**
 * HMAC-SHA256 guard for `POST /api/indexers/run`. Verifies:
 *   - `INDEXER_CRON_SECRET` is configured (otherwise endpoint is hard-disabled).
 *   - Source IP is in `INDEXER_ALLOWED_IPS` (when configured; empty list = no allowlist).
 *   - `x-signature` header equals `HMAC-SHA256(secret, "${ts}:${pathname}")`.
 *   - `x-timestamp` header is within ±5 minutes of server clock.
 *
 * Mirrors the trigger semantics of the dashboard's `/api/indexers/run`.
 */
@Injectable()
export class HmacGuard implements CanActivate {
    constructor(private readonly config: ConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        const secret = this.config.get<string>("indexer.cronSecret");
        if (!secret) {
            // Endpoint is hard-disabled when no secret is set. Treat as
            // unauthorized so probes don't accidentally trigger work.
            throw new BusinessException(ErrorCode.INDEXER_TRIGGER_UNAUTHORIZED);
        }

        const allowedIps = this.config.get<string[]>("indexer.allowedIps") ?? [];
        if (allowedIps.length > 0) {
            const sourceIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ?? req.socket?.remoteAddress ?? "";
            if (!allowedIps.includes(sourceIp)) {
                throw new BusinessException(ErrorCode.INDEXER_TRIGGER_FORBIDDEN_IP);
            }
        }

        const tsRaw = (req.headers["x-timestamp"] ?? "") as string;
        const ts = Number(tsRaw);
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_SKEW_WINDOW_MS) {
            throw new BusinessException(ErrorCode.INDEXER_TRIGGER_REPLAY);
        }

        const signature = ((req.headers["x-signature"] ?? "") as string).toLowerCase();
        const expected = createHmac("sha256", secret).update(`${tsRaw}:${req.path}`).digest("hex");

        const sigBuf = Buffer.from(signature, "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
            throw new BusinessException(ErrorCode.INDEXER_TRIGGER_UNAUTHORIZED);
        }

        return true;
    }
}
