import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { ConsumerHealthService } from "./consumer-health.service";

@Injectable()
export class ConsumerHealthCommand {
    private readonly logger = new Logger(ConsumerHealthCommand.name);

    constructor(private readonly service: ConsumerHealthService) {}

    @Command({ command: "health:consumer", describe: "Classify consumer-tx receipts (3-outcome generic)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`health:consumer result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
