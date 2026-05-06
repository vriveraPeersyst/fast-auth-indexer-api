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
    logger.log("Indexer worker started; cron schedulers active.");
}
bootstrap();
