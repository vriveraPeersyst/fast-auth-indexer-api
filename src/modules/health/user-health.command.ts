import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { UserHealthService } from "./user-health.service";

@Injectable()
export class UserHealthCommand {
    private readonly logger = new Logger(UserHealthCommand.name);

    constructor(private readonly service: UserHealthService) {}

    @Command({ command: "health:user", describe: "Classify user-activity tx receipts (3-outcome generic)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`health:user result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
