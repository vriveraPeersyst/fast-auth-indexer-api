import { getNestTypeORMConfig } from "./typeormConfig";

export default (): any => ({
    server: {
        // Railway injects PORT; APP_PORT is the local-dev fallback.
        port: parseInt(process.env.PORT || process.env.APP_PORT, 10) || 3000,
        enableSwagger: process.env.APP_ENABLE_SWAGGER === "1",
        enableCORS: process.env.APP_ENABLE_CORS === "1",
    },
    database: getNestTypeORMConfig(),
    indexer: {
        cronSecret: process.env.INDEXER_CRON_SECRET || "",
        allowedIps: (process.env.INDEXER_ALLOWED_IPS || "")
            .split(",")
            .map((ip) => ip.trim())
            .filter(Boolean),
    },
    near: {
        network: process.env.NEAR_NETWORK || "mainnet",
        fastauthContractIds: (process.env.NEAR_FASTAUTH_CONTRACT_IDS || "fast-auth.near,jwt.fast-auth.near,auth0.jwt.fast-auth.near")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        mpcContractIds: (process.env.NEAR_MPC_CONTRACT_IDS || "v1.signer")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
        syntheticSignerIds: (process.env.SYNTHETIC_SIGNER_IDS || "tx-bench.near")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean),
    },
    fastnear: {
        apiBase: process.env.FASTNEAR_API_BASE || "https://api.fastnear.com",
    },
    logger: {
        logLevel: process.env.LOG_LEVEL || "info",
        logFileName: process.env.LOG_FILE || "logs/app.log",
    },
});
