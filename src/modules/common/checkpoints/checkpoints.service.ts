import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { IndexerCheckpoint } from "../../../database/entities/IndexerCheckpoint";

/**
 * Thin repository wrapper around `indexer_checkpoints`. All collectors store
 * their forward-progress markers, throttling timestamps, and one-shot run
 * sentinels here as plain key/value strings — never substitute in-memory state.
 *
 * Numeric checkpoints are stringified at the call site (block heights, event
 * IDs, ms timestamps). The table doesn't enforce a schema beyond the key.
 */
@Injectable()
export class CheckpointsService {
    constructor(@InjectRepository(IndexerCheckpoint) private readonly repository: Repository<IndexerCheckpoint>) {}

    async get(key: string): Promise<string | null> {
        const row = await this.repository.findOne({ where: { key } });
        return row?.value ?? null;
    }

    async getNumber(key: string): Promise<number | null> {
        const value = await this.get(key);
        if (value === null) return null;
        const num = Number(value);
        return Number.isFinite(num) ? num : null;
    }

    async getBigInt(key: string): Promise<bigint | null> {
        const value = await this.get(key);
        if (value === null) return null;
        try {
            return BigInt(value);
        } catch {
            return null;
        }
    }

    async set(key: string, value: string): Promise<void> {
        // updatedAt is NOT NULL in the DB and has no DDL-level default
        // (Prisma's @updatedAt is application-side). repository.upsert() does
        // not fire @UpdateDateColumn, so we set it explicitly.
        await this.repository.upsert({ key, value, updatedAt: new Date() }, ["key"]);
    }

    async setMany(entries: Array<{ key: string; value: string }>): Promise<void> {
        if (entries.length === 0) return;
        const now = new Date();
        await this.repository.upsert(
            entries.map((e) => ({ key: e.key, value: e.value, updatedAt: now })),
            ["key"],
        );
    }

    async setNumber(key: string, value: number): Promise<void> {
        await this.set(key, String(value));
    }

    async setBigInt(key: string, value: bigint): Promise<void> {
        await this.set(key, value.toString());
    }

    async delete(key: string): Promise<void> {
        await this.repository.delete({ key });
    }
}
