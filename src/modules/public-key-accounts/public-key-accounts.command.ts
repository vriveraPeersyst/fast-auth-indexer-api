import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { PublicKeyAccountsService } from "./public-key-accounts.service";

@Injectable()
export class PublicKeyAccountsCommand {
    private readonly logger = new Logger(PublicKeyAccountsCommand.name);

    constructor(private readonly service: PublicKeyAccountsService) {}

    @Command({ command: "pka:run", describe: "Resolve FastAuth-derived public keys → NEAR account IDs (via FastNEAR + MPC view-call)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`pka:run result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
