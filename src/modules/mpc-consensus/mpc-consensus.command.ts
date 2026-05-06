import { Injectable, Logger } from "@nestjs/common";
import { Command } from "nestjs-command";

import { MpcConsensusService } from "./mpc-consensus.service";

@Injectable()
export class MpcConsensusCommand {
    private readonly logger = new Logger(MpcConsensusCommand.name);

    constructor(private readonly service: MpcConsensusService) {}

    @Command({ command: "mpc:run", describe: "Run one MPC consensus discovery cycle (respond + sign-direct + sign-fastauth + governance)" })
    async run(): Promise<void> {
        const result = await this.service.runOnce();
        this.logger.log(`mpc:run result=${JSON.stringify(result)}`);
        if (result.status === "error") {
            process.exitCode = 1;
        }
    }
}
