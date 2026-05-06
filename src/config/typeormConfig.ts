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
export function getTypeORMConfig(): DataSourceOptions {
    const url = process.env.DATABASE_URL;
    const enableSsl = process.env.NODE_ENV === "production" || process.env.DB_SSL === "1";
    const ssl = enableSsl ? { rejectUnauthorized: false } : false;

    const base: Pick<DataSourceOptions, "type" | "synchronize" | "migrationsRun" | "entities" | "migrations"> = {
        type: "postgres",
        synchronize: process.env.DB_SYNCHRONIZE === "1",
        migrationsRun: process.env.DB_MIGRATIONS_RUN === "1",
        entities: [__dirname + "/../database/entities/*{.ts,.js}"],
        migrations: [__dirname + "/../database/migrations/**/*{.ts,.js}"],
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
