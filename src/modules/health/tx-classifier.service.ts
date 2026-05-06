import { Injectable } from "@nestjs/common";

import { NearRpcService } from "../common/near-rpc/near-rpc.service";
import { extractFailureReason, isFailureStatus } from "./health-status.helpers";

export type GenericOutcome = "success" | "failure" | "rpc_pending";

export type GenericClassification = {
    outcome: GenericOutcome;
    failingExecutorId: string | null;
    failureReason: string | null;
    /** RPC-level error message — only set when the tx call itself failed. */
    lastError: string | null;
};

type NearReceiptOutcome = {
    outcome?: { executor_id?: string; status?: unknown };
};

type NearTxStatusResponse = {
    result?: {
        transaction_outcome?: { outcome?: { executor_id?: string; status?: unknown } };
        receipts_outcome?: NearReceiptOutcome[];
    };
};

/**
 * Generic per-tx receipt-walking classifier used by the consumer + user health
 * collectors. Walks the tx's receipts; if any receipt failed, captures the
 * first failure's executor and reason. RPC errors → rpc_pending so the tx gets
 * retried later (caller is responsible for retry caps).
 *
 * The FastAuth health collector has its own 5-outcome variant (guard / mpc /
 * other_failure splits) inlined in `FastauthHealthService` since it needs the
 * MPC contract set as additional context.
 */
@Injectable()
export class TxClassifierService {
    constructor(private readonly nearRpc: NearRpcService) {}

    async classifyTxGeneric(txHash: string, signerId: string, source: string): Promise<GenericClassification> {
        let txStatus: NearTxStatusResponse;
        try {
            txStatus = await this.nearRpc.request<NearTxStatusResponse>("tx", [txHash, signerId], `${source}:tx ${txHash}`);
        } catch (error) {
            return {
                outcome: "rpc_pending",
                failingExecutorId: null,
                failureReason: null,
                lastError: error instanceof Error ? error.message : String(error),
            };
        }

        const receipts = txStatus.result?.receipts_outcome ?? [];
        let firstFailingExecutor: string | null = null;
        let firstFailingStatus: unknown = null;

        for (const receipt of receipts) {
            if (firstFailingExecutor === null && isFailureStatus(receipt.outcome?.status)) {
                firstFailingExecutor = receipt.outcome?.executor_id?.trim().toLowerCase() ?? null;
                firstFailingStatus = receipt.outcome?.status;
            }
        }

        const txConversionStatus = txStatus.result?.transaction_outcome?.outcome?.status;
        const txConversionFailed = isFailureStatus(txConversionStatus);
        const anyFailure = firstFailingExecutor !== null || txConversionFailed;

        if (!anyFailure) {
            return { outcome: "success", failingExecutorId: null, failureReason: null, lastError: null };
        }

        const failureReason = extractFailureReason(firstFailingStatus) ?? extractFailureReason(txConversionStatus);

        return { outcome: "failure", failingExecutorId: firstFailingExecutor, failureReason, lastError: null };
    }
}
