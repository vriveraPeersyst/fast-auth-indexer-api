import { Injectable, Logger } from "@nestjs/common";
import { Command, Option, Positional } from "nestjs-command";

import { RelayerMartsService } from "../near-ingest/relayer-marts.service";
import { SeedMissingRangesService } from "./seed-missing-ranges.service";
import { SkipForwardService } from "./skip-forward.service";
import { WipeDbService } from "./wipe-db.service";

@Injectable()
export class WipeDbCommand {
    private readonly logger = new Logger(WipeDbCommand.name);

    constructor(private readonly service: WipeDbService) {}

    @Command({
        command: "ops:wipe-db",
        describe: "DESTRUCTIVE: truncate every indexer-managed table. Run only against a non-prod DB.",
    })
    async run(
        @Option({ name: "confirm", describe: "Required to actually run the wipe (otherwise dry-run)", type: "boolean", default: false })
        confirm: boolean,
    ): Promise<void> {
        if (!confirm) {
            this.logger.warn("(dry run) Re-run with --confirm to actually wipe the DB.");
            return;
        }
        const summary = await this.service.wipe();
        this.logger.log(`ops:wipe-db result=${JSON.stringify(summary)}`);
    }
}

@Injectable()
export class RebuildMartsCommand {
    private readonly logger = new Logger(RebuildMartsCommand.name);

    constructor(private readonly relayerMarts: RelayerMartsService) {}

    @Command({
        command: "ops:rebuild-marts",
        describe: "Rebuild relayers mart from scratch (delete-then-insert).",
    })
    async run(): Promise<void> {
        const relayer = await this.relayerMarts.rebuild();
        this.logger.log(`ops:rebuild-marts result=${JSON.stringify({ relayers: relayer.relayers })}`);
    }
}

@Injectable()
export class SeedMissingRangesCommand {
    private readonly logger = new Logger(SeedMissingRangesCommand.name);

    constructor(private readonly service: SeedMissingRangesService) {}

    @Command({
        command: "ops:seed-missing-ranges [path]",
        describe: "Read a legacy missing-block-ranges JSON file and upsert each entry into the DB table.",
    })
    async run(
        @Positional({ name: "path", describe: "Path to JSON file (defaults to data/missing-block-ranges.json)", type: "string" })
        path: string | undefined,
    ): Promise<void> {
        const result = await this.service.seed(path);
        this.logger.log(`ops:seed-missing-ranges result=${JSON.stringify(result)}`);
    }
}

@Injectable()
export class SkipForwardCommand {
    private readonly logger = new Logger(SkipForwardCommand.name);

    constructor(private readonly service: SkipForwardService) {}

    @Command({
        command: "ops:skip-forward",
        describe: "DESTRUCTIVE: record gap from current scanned height to chain tip, advance checkpoints. Dry-run by default.",
    })
    async run(
        @Option({ name: "confirm", describe: "Required to actually advance checkpoints", type: "boolean", default: false })
        confirm: boolean,
        @Option({ name: "hours-back", describe: "Skip to this many hours before chain tip", type: "number", default: 12 })
        hoursBack: number,
    ): Promise<void> {
        const summary = await this.service.run(confirm, hoursBack);
        this.logger.log(`ops:skip-forward result=${JSON.stringify(summary)}`);
    }
}
