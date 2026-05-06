import { HttpStatus } from "@nestjs/common";

// Define app error codes
enum AppErrorCode {
    INDEXER_TRIGGER_UNAUTHORIZED = "INDEXER_TRIGGER_UNAUTHORIZED",
    INDEXER_TRIGGER_REPLAY = "INDEXER_TRIGGER_REPLAY",
    INDEXER_TRIGGER_FORBIDDEN_IP = "INDEXER_TRIGGER_FORBIDDEN_IP",
    CHECKPOINT_NOT_FOUND = "CHECKPOINT_NOT_FOUND",
    NEAR_RPC_EXHAUSTED = "NEAR_RPC_EXHAUSTED",
    DASHBOARD_DATA_UNAVAILABLE = "DASHBOARD_DATA_UNAVAILABLE",
}

export const ErrorCode = { ...AppErrorCode };
export type ErrorCodeType = AppErrorCode;

export const ErrorBody: { [code in ErrorCodeType]: { statusCode: HttpStatus; message: string } } = {
    [ErrorCode.INDEXER_TRIGGER_UNAUTHORIZED]: {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: ErrorCode.INDEXER_TRIGGER_UNAUTHORIZED,
    },
    [ErrorCode.INDEXER_TRIGGER_REPLAY]: {
        statusCode: HttpStatus.UNAUTHORIZED,
        message: ErrorCode.INDEXER_TRIGGER_REPLAY,
    },
    [ErrorCode.INDEXER_TRIGGER_FORBIDDEN_IP]: {
        statusCode: HttpStatus.FORBIDDEN,
        message: ErrorCode.INDEXER_TRIGGER_FORBIDDEN_IP,
    },
    [ErrorCode.CHECKPOINT_NOT_FOUND]: {
        statusCode: HttpStatus.NOT_FOUND,
        message: ErrorCode.CHECKPOINT_NOT_FOUND,
    },
    [ErrorCode.NEAR_RPC_EXHAUSTED]: {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: ErrorCode.NEAR_RPC_EXHAUSTED,
    },
    [ErrorCode.DASHBOARD_DATA_UNAVAILABLE]: {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: ErrorCode.DASHBOARD_DATA_UNAVAILABLE,
    },
};
