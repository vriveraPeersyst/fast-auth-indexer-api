import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { FastauthContractStateService } from "./fastauth-contract-state.service";

@Injectable()
export class FastauthContractStateCommand {
    private readonly logger = new Logger(FastauthContractStateCommand.name);

    constructor(private readonly service: FastauthContractStateService) {}

    @Command({ command: "fac-state:snapshot", describe: "Snapshot FastAuth contract state (mainnet trio)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        // Structured one-line log so `railway logs` / Jenkins console stays grep-able.
        this.logger.log(`fac-state:snapshot result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
