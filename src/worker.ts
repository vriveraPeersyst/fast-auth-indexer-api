import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { utilities as nestWinstonModuleUtilities, WinstonModule } from "nest-winston";
import * as winston from "winston";

import { WorkerModule } from "./worker.module";

async function bootstrap(): Promise<void> {
    // Buffer logs until Winston is wired so the very first init lines aren't
    // dropped by the default Nest logger.
    const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

    const config = app.get(ConfigService);
    const logLevel = config.get("logger.logLevel");
    const logFileName = config.get("logger.logFileName");

    const logger = WinstonModule.createLogger({
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(winston.format.timestamp(), nestWinstonModuleUtilities.format.nestLike()),
            }),
            new winston.transports.File({
                format: winston.format.combine(winston.format.timestamp(), nestWinstonModuleUtilities.format.nestLike()),
                level: logLevel,
                filename: logFileName,
            }),
        ],
    });
    app.useLogger(logger);
    app.enableShutdownHooks();

    // Observe unhandled rejections so V8 can GC their captured closures
    // (otherwise a swallowed RPC error retains its body buffer indefinitely).
    process.on("unhandledRejection", (reason) => {
        logger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    });

    // Periodic heap snapshot — makes the next OOM a 30s diagnosis, not 3 days
    // of forensics. rss is what Railway's container-memory metric reports.
    const memInterval = setInterval(() => {
        const m = process.memoryUsage();
        const fmt = (n: number): string => `${Math.round(n / 1024 / 1024)}MB`;
        logger.log(`mem rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)} heapTotal=${fmt(m.heapTotal)} external=${fmt(m.external)}`);
    }, 60_000);
    memInterval.unref();

    logger.log("Indexer worker started; cron schedulers active.");
}
bootstrap();
