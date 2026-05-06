import { Module } from "@nestjs/common";
import { HealthApiController } from "./health-api.controller";

@Module({
    controllers: [HealthApiController],
})
export class HealthApiModule {}
