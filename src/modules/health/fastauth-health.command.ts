import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { FastauthHealthService } from "./fastauth-health.service";

@Injectable()
export class FastauthHealthCommand {
    private readonly logger = new Logger(FastauthHealthCommand.name);

    constructor(private readonly service: FastauthHealthService) {}

    @Command({ command: "health:fastauth", describe: "Classify FA-receiver tx receipts (5-outcome guard/MPC split)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`health:fastauth result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
