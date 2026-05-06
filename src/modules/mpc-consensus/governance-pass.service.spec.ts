import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";

import { MpcConsensusEvent } from "../../database/entities/MpcConsensusEvent";
import { MpcTransaction } from "../../database/entities/MpcTransaction";
import { GovernancePassService } from "./governance-pass.service";

function makeQueryBuilderMock(): any {
    const qb: any = {};
    qb.insert = jest.fn(() => qb);
    qb.values = jest.fn(() => qb);
    qb.orIgnore = jest.fn(() => qb);
    qb.execute = jest.fn().mockResolvedValue({ identifiers: [] });
    return qb;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("GovernancePassService", () => {
    let service: GovernancePassService;
    let mpcTxRepo: { query: jest.Mock };
    let eventRepo: { createQueryBuilder: jest.Mock };
    let eventQb: any;

    beforeEach(async () => {
        mpcTxRepo = { query: jest.fn() };
        eventQb = makeQueryBuilderMock();
        eventRepo = { createQueryBuilder: jest.fn(() => eventQb) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                GovernancePassService,
                { provide: getRepositoryToken(MpcTransaction), useValue: mpcTxRepo },
                { provide: getRepositoryToken(MpcConsensusEvent), useValue: eventRepo },
            ],
        }).compile();

        service = moduleRef.get(GovernancePassService);
    });

    it("returns zeroes when no candidates", async () => {
        mpcTxRepo.query.mockResolvedValue([]);

        const result = await service.run(new Date());

        expect(result).toEqual({ discovered: 0, inserted: 0 });
        expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it("decodes args and persists rows with correct category", async () => {
        const args = b64(JSON.stringify({ epoch: 7 }));
        mpcTxRepo.query.mockResolvedValue([
            {
                tx_hash: "g1",
                signer_account_id: "node1.pool.near",
                method_name: "vote_pk",
                block_height: "200",
                block_timestamp: new Date("2026-01-02"),
                execution_status: "SUCCESS_VALUE",
                payload_json: { actions: [{ FunctionCall: { method_name: "vote_pk", args } }] },
            },
        ]);
        eventQb.execute.mockResolvedValue({ identifiers: [{ txHash: "g1" }] });

        const result = await service.run(new Date());

        expect(result).toEqual({ discovered: 1, inserted: 1 });
        expect(eventQb.values).toHaveBeenCalledWith([
            expect.objectContaining({
                txHash: "g1",
                eventType: "vote_pk",
                category: "key_events",
                actorId: "node1.pool.near",
                payload: { epoch: 7 },
            }),
        ]);
    });

    it("falls back actorId to '(unknown)' when signer_account_id is null", async () => {
        mpcTxRepo.query.mockResolvedValue([
            {
                tx_hash: "g1",
                signer_account_id: null,
                method_name: "vote_pk",
                block_height: "200",
                block_timestamp: new Date(),
                execution_status: null,
                payload_json: {},
            },
        ]);
        eventQb.execute.mockResolvedValue({ identifiers: [] });

        await service.run(new Date());

        expect(eventQb.values).toHaveBeenCalledWith([expect.objectContaining({ actorId: "(unknown)" })]);
    });
});
