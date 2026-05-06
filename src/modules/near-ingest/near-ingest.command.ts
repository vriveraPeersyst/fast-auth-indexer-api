import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { NearIngestService } from "./near-ingest.service";

@Injectable()
export class NearIngestCommand {
    private readonly logger = new Logger(NearIngestCommand.name);

    constructor(private readonly service: NearIngestService) {}

    @Command({
        command: "near:ingest",
        describe: "Walk NEAR blocks; persist FA / consumer / user / MPC transactions; rebuild relayer marts",
    })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`near:ingest result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
