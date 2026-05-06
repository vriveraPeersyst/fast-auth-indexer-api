import { categorizeGovernanceMethod, MPC_GOVERNANCE_METHODS } from "./governance-categorizer";

describe("categorizeGovernanceMethod", () => {
    it("buckets TEE attestation methods", () => {
        expect(categorizeGovernanceMethod("submit_participant_info")).toBe("tee");
        expect(categorizeGovernanceMethod("verify_tee")).toBe("tee");
        expect(categorizeGovernanceMethod("clean_invalid_attestations")).toBe("tee");
        expect(categorizeGovernanceMethod("clean_tee_status")).toBe("tee");
    });

    it("buckets version voting methods", () => {
        expect(categorizeGovernanceMethod("vote_code_hash")).toBe("version");
        expect(categorizeGovernanceMethod("vote_add_launcher_hash")).toBe("version");
        expect(categorizeGovernanceMethod("vote_remove_launcher_hash")).toBe("version");
        expect(categorizeGovernanceMethod("vote_add_os_measurement")).toBe("version");
        expect(categorizeGovernanceMethod("vote_remove_os_measurement")).toBe("version");
    });

    it("buckets key event lifecycle methods", () => {
        expect(categorizeGovernanceMethod("vote_pk")).toBe("key_events");
        expect(categorizeGovernanceMethod("vote_reshared")).toBe("key_events");
        expect(categorizeGovernanceMethod("vote_abort_key_event_instance")).toBe("key_events");
        expect(categorizeGovernanceMethod("vote_cancel_keygen")).toBe("key_events");
        expect(categorizeGovernanceMethod("vote_cancel_resharing")).toBe("key_events");
        expect(categorizeGovernanceMethod("vote_add_domains")).toBe("key_events");
        expect(categorizeGovernanceMethod("start_keygen_instance")).toBe("key_events");
        expect(categorizeGovernanceMethod("start_reshare_instance")).toBe("key_events");
    });

    it("buckets contract update methods", () => {
        expect(categorizeGovernanceMethod("vote_new_parameters")).toBe("updates");
        expect(categorizeGovernanceMethod("vote_update")).toBe("updates");
        expect(categorizeGovernanceMethod("propose_update")).toBe("updates");
        expect(categorizeGovernanceMethod("remove_update_vote")).toBe("updates");
    });

    it("buckets foreign-chain methods", () => {
        expect(categorizeGovernanceMethod("vote_foreign_chain_policy")).toBe("foreign_chains");
        expect(categorizeGovernanceMethod("register_foreign_chain_config")).toBe("foreign_chains");
    });

    it("buckets node migration methods", () => {
        expect(categorizeGovernanceMethod("start_node_migration")).toBe("migration");
        expect(categorizeGovernanceMethod("conclude_node_migration")).toBe("migration");
        expect(categorizeGovernanceMethod("register_backup_service")).toBe("migration");
    });

    it("falls back to 'other' for unknown methods", () => {
        expect(categorizeGovernanceMethod("totally_unknown_method")).toBe("other");
    });

    it("MPC_GOVERNANCE_METHODS includes representative entries", () => {
        expect(MPC_GOVERNANCE_METHODS.has("vote_code_hash")).toBe(true);
        expect(MPC_GOVERNANCE_METHODS.has("vote_pk")).toBe(true);
        expect(MPC_GOVERNANCE_METHODS.has("never_a_method")).toBe(false);
    });
});
