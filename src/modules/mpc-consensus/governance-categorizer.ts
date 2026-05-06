/**
 * Governance / control-plane methods on v1.signer. Anything matching goes into
 * `mpc_consensus_events` with its category. List is explicit (not "everything
 * that isn't sign/respond") so unknown methods stay visible as gaps and we can
 * decide whether to map them.
 */
export const MPC_GOVERNANCE_METHODS: ReadonlySet<string> = new Set([
    // TEE attestation
    "submit_participant_info",
    "verify_tee",
    "clean_invalid_attestations",
    "clean_tee_status",
    // Code / launcher / OS hash voting
    "vote_code_hash",
    "vote_add_launcher_hash",
    "vote_remove_launcher_hash",
    "vote_add_os_measurement",
    "vote_remove_os_measurement",
    // Key event lifecycle
    "vote_pk",
    "vote_reshared",
    "vote_abort_key_event_instance",
    "vote_cancel_keygen",
    "vote_cancel_resharing",
    "vote_add_domains",
    "start_keygen_instance",
    "start_reshare_instance",
    // Network parameters / contract upgrades
    "vote_new_parameters",
    "vote_update",
    "propose_update",
    "remove_update_vote",
    // Foreign chain governance
    "vote_foreign_chain_policy",
    "register_foreign_chain_config",
    // Node migration
    "start_node_migration",
    "conclude_node_migration",
    "register_backup_service",
]);

export type GovernanceCategory = "tee" | "version" | "key_events" | "updates" | "foreign_chains" | "migration" | "other";

export function categorizeGovernanceMethod(method: string): GovernanceCategory {
    if (method === "submit_participant_info" || method === "verify_tee" || method.startsWith("clean_")) {
        return "tee";
    }
    if (
        method === "vote_code_hash" ||
        method.startsWith("vote_add_launcher_hash") ||
        method.startsWith("vote_remove_launcher_hash") ||
        method.startsWith("vote_add_os_measurement") ||
        method.startsWith("vote_remove_os_measurement")
    ) {
        return "version";
    }
    if (
        method === "vote_pk" ||
        method === "vote_reshared" ||
        method === "vote_abort_key_event_instance" ||
        method === "vote_cancel_keygen" ||
        method === "vote_cancel_resharing" ||
        method === "vote_add_domains" ||
        method.startsWith("start_keygen_") ||
        method.startsWith("start_reshare_")
    ) {
        return "key_events";
    }
    if (method === "vote_new_parameters" || method === "vote_update" || method === "propose_update" || method === "remove_update_vote") {
        return "updates";
    }
    if (method.includes("foreign_chain")) return "foreign_chains";
    if (method.includes("migration") || method === "register_backup_service") return "migration";
    return "other";
}
