import { NestFactory } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as OpenApiValidator from "express-openapi-validator";
import * as fs from "fs";
import Helmet from "helmet";
import * as morgan from "morgan";
import { utilities as nestWinstonModuleUtilities, WinstonModule } from "nest-winston";
import * as winston from "winston";
import { AppModule } from "./app.module";
import * as packageJson from "../package.json";

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);
    const logLevel = configService.get("logger.logLevel");
    const logFileName = configService.get("logger.logFileName");
    const serverPort = configService.get("server.port");

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
    app.use(Helmet());
    app.use(morgan("tiny"));
    app.setGlobalPrefix("api");

    if (configService.get("server.enableCORS")) {
        app.enableCors();
    }
    const options = new DocumentBuilder()
        .setTitle(packageJson.name)
        .setDescription(packageJson.description)
        .setVersion(packageJson.version)
        .addBearerAuth()
        .build();
    const document = SwaggerModule.createDocument(app, options);
    fs.writeFileSync("./openapi-spec.json", JSON.stringify(document));

    // Mount OpenAPI request validator using the in-memory document so
    // the validator always sees the freshest spec — no chicken-and-egg
    // with on-disk file dependencies.
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

    // Bind 0.0.0.0 explicitly — Railway's healthcheck proxy talks to the
    // container over the external network interface; default localhost
    // binding is unreachable.
    await app.listen(serverPort, "0.0.0.0");
    logger.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
