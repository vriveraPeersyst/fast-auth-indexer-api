import { Module } from "@nestjs/common";
import { NearRpcService } from "./near-rpc.service";

@Module({
    providers: [NearRpcService],
    exports: [NearRpcService],
})
export class NearRpcModule {}
