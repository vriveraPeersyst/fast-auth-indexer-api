import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrorDecorators } from "../common/exception/error-response.decorator";
import { HealthDto } from "./dtos/health.dto";

/**
 * Liveness/readiness probe. Mirrors the dashboard's old `/api/health` route —
 * cheap, dependency-free, used by Railway healthchecks and uptime monitors.
 */
@ApiTags("health")
@Controller("health")
@ApiErrorDecorators()
export class HealthApiController {
    @Get("")
    @ApiOperation({ summary: "Service liveness probe" })
    health(): HealthDto {
        return {
            ok: true,
            service: "fast-auth-indexer-api",
            timestamp: new Date().toISOString(),
        };
    }
}
