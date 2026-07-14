import { DataSourceOptions, DataSource } from "typeorm";

export type NestConnectionOptions = DataSourceOptions & {
    autoLoadEntities?: boolean;
    keepConnectionAlive?: boolean;
    retryDelay?: number;
    retryAttempts?: number;
};

/**
 * Build TypeORM config preferring `DATABASE_URL` (Railway / Heroku-style
 * connection string) when present, falling back to individual DB_* vars for
 * local dev. SSL is required on managed Postgres providers (Railway,
 * Supabase, RDS) — enabled when `NODE_ENV=production` or explicit `DB_SSL=1`.
 */
/**
 * Node-`pg` pool + timeout knobs applied to every connection. Two goals:
 *   - `statement_timeout` / `query_timeout`: no single query can pin a pool
 *     connection for minutes. The read endpoints are now single-row SELECTs,
 *     so the only heavy consumer is the background dashboard-snapshot job —
 *     whose sections already degrade to typed defaults via `Promise.allSettled`
 *     when a slot rejects, so a timed-out section is self-healing (retried next
 *     cycle) rather than a hard failure.
 *   - `max`: size the pool explicitly instead of inheriting pg's implicit 10,
 *     which the old on-demand `/status` fan-out (~60 concurrent queries) used
 *     to saturate, starving even the indexer crons in this same process.
 *
 * Overridable via env for ops tuning without a code change.
 */
function poolExtra(): Record<string, unknown> {
    const num = (raw: string | undefined, fallback: number): number => {
        const parsed = raw ? Number(raw) : NaN;
        return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
    };
    const statementTimeoutMs = num(process.env.DB_STATEMENT_TIMEOUT_MS, 60_000);
    return {
        max: num(process.env.DB_POOL_MAX, 24),
        statement_timeout: statementTimeoutMs,
        query_timeout: statementTimeoutMs,
        idleTimeoutMillis: num(process.env.DB_POOL_IDLE_TIMEOUT_MS, 30_000),
    };
}

export function getTypeORMConfig(): DataSourceOptions {
    const url = process.env.DATABASE_URL;
    const enableSsl = process.env.NODE_ENV === "production" || process.env.DB_SSL === "1";
    const ssl = enableSsl ? { rejectUnauthorized: false } : false;

    const base: Pick<DataSourceOptions, "type" | "synchronize" | "migrationsRun" | "entities" | "migrations" | "extra"> = {
        type: "postgres",
        synchronize: process.env.DB_SYNCHRONIZE === "1",
        migrationsRun: process.env.DB_MIGRATIONS_RUN === "1",
        entities: [__dirname + "/../database/entities/*{.ts,.js}"],
        migrations: [__dirname + "/../database/migrations/**/*{.ts,.js}"],
        extra: poolExtra(),
    };

    if (url) {
        return { ...base, url, ssl } as DataSourceOptions;
    }

    return {
        ...base,
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT, 10),
        username: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        ssl,
    } as DataSourceOptions;
}

export function getDataSource(): DataSource {
    return new DataSource(getTypeORMConfig());
}

export function getNestTypeORMConfig(): NestConnectionOptions {
    return {
        ...getTypeORMConfig(),
        autoLoadEntities: true,
    };
}

export default getDataSource();
