import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as OpenApiValidator from "express-openapi-validator";
import Helmet from "helmet";
import * as morgan from "morgan";
import { utilities as nestWinstonModuleUtilities, WinstonModule } from "nest-winston";
import * as winston from "winston";

import { WorkerModule } from "./worker.module";
import * as packageJson from "../package.json";

/**
 * Single-process bootstrap: HTTP API + cron schedulers in one Nest app.
 * See worker.module.ts for the consolidation rationale.
 */
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(WorkerModule, { bufferLogs: true });

    const configService = app.get(ConfigService);
    const serverPort = configService.get("server.port");

    const logger = WinstonModule.createLogger({
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(winston.format.timestamp(), nestWinstonModuleUtilities.format.nestLike()),
            }),
        ],
    });
    app.useLogger(logger);
    app.enableShutdownHooks();

    app.use(Helmet());
    app.use(morgan("tiny"));
    app.setGlobalPrefix("api");

    if (configService.get("server.enableCORS")) {
        app.enableCors();
    }

    const swaggerOptions = new DocumentBuilder()
        .setTitle(packageJson.name)
        .setDescription(packageJson.description)
        .setVersion(packageJson.version)
        .addBearerAuth()
        .build();
    const document = SwaggerModule.createDocument(app, swaggerOptions);

    // Mount OpenAPI request validator using the in-memory document so the
    // validator always sees the freshest spec — no chicken-and-egg with
    // on-disk file dependencies.
    app.use(
        OpenApiValidator.middleware({
            apiSpec: document as never,
            validateRequests: {
                allowUnknownQueryParameters: true,
                coerceTypes: false,
            },
            validateResponses: false,
            validateFormats: "full",
        }),
    );

    if (configService.get("server.enableSwagger")) {
        SwaggerModule.setup("swagger", app, document);
    }

    process.on("unhandledRejection", (reason) => {
        logger.error(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
    });

    // Periodic heap snapshot — makes the next OOM a 30s diagnosis, not 3 days
    // of forensics. rss is what Railway's container-memory metric reports.
    const memInterval = setInterval(() => {
        const m = process.memoryUsage();
        const fmt = (n: number): string => `${Math.round(n / 1024 / 1024)}MB`;
        logger.log(`mem rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)} heapTotal=${fmt(m.heapTotal)} external=${fmt(m.external)}`);
    }, 5 * 60_000);
    memInterval.unref();

    // Bind 0.0.0.0 explicitly — Railway's healthcheck proxy talks to the
    // container over the external network interface; default localhost
    // binding is unreachable.
    await app.listen(serverPort, "0.0.0.0");
    logger.log(`Application listening on http://0.0.0.0:${serverPort}; cron schedulers active.`);
}
bootstrap();
