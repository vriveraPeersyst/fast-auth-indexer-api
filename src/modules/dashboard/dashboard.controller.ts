import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrorDecorators } from "../common/exception/error-response.decorator";
import { DashboardDataService } from "./dashboard-data.service";
import { DashboardData } from "./dashboard-data.types";
import { DashboardService } from "./dashboard.service";
import { ContractSnapshotDto, ContractSnapshotsResponseDto } from "./dtos/contract-snapshot.dto";
import { OverviewDto } from "./dtos/overview.dto";
import { MetricsPayload, MetricsService } from "./metrics.service";
import { StatusData } from "./status.types";

const PUBLIC_CACHE = "public, max-age=60, s-maxage=60, stale-while-revalidate=300";
const CORS_ANY = "*";

@ApiTags("dashboard")
@Controller("public")
@ApiErrorDecorators()
export class DashboardController {
    constructor(
        private readonly dashboard: DashboardService,
        private readonly metrics: MetricsService,
        private readonly dashboardData: DashboardDataService,
    ) {}

    @Get("metrics")
    @Header("Cache-Control", PUBLIC_CACHE)
    @Header("Access-Control-Allow-Origin", CORS_ANY)
    @ApiOperation({ summary: "Public landing-page KPIs: account counts, sign events, relayers, 24h uptime%." })
    async getPublicMetrics(): Promise<MetricsPayload> {
        return this.metrics.getMetrics();
    }

    @Get("dashboard-data")
    @Header("Cache-Control", PUBLIC_CACHE)
    @Header("Access-Control-Allow-Origin", CORS_ANY)
    @ApiOperation({
        summary:
            "Comprehensive read-side payload mirroring the dashboard repo's getDashboardData(). Used by the hosted dashboard frontend.",
    })
    async getDashboardData(): Promise<DashboardData> {
        return this.dashboardData.getDashboardData();
    }

    @Get("overview")
    @ApiOperation({ summary: "Aggregate counts: sign events, accounts, relayers, latest snapshot timestamp." })
    async getOverview(): Promise<OverviewDto> {
        return this.dashboard.getOverview();
    }

    @Get("status")
    @Header("Cache-Control", PUBLIC_CACHE)
    @Header("Access-Control-Allow-Origin", CORS_ANY)
    @ApiOperation({
        summary:
            "Comprehensive read-only status payload — projection of getDashboardData() into the JSON contract consumed by the FastAuth landing page's /status route.",
    })
    async getStatus(): Promise<StatusData> {
        return this.dashboardData.getStatus();
    }

    @Get("contracts")
    @ApiOperation({ summary: "Latest FastAuth contract-state snapshot per tracked contract." })
    async getContracts(): Promise<ContractSnapshotsResponseDto> {
        const entities = await this.dashboard.getLatestContractSnapshots();
        return { snapshots: entities.map((e) => ContractSnapshotDto.fromEntity(e)) };
    }
}
