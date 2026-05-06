import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { Relayer } from "../../database/entities/Relayer";
import { RelayerMartsService } from "./relayer-marts.service";

function makeAggregateQbMock(rawRows: any[]): any {
    const qb: any = {};
    qb.select = jest.fn(() => qb);
    qb.addSelect = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.groupBy = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rawRows);
    return qb;
}

describe("RelayerMartsService", () => {
    let service: RelayerMartsService;
    let signEventRepo: { createQueryBuilder: jest.Mock };
    let relayerRepo: any;
    let dataSource: { transaction: jest.Mock };
    let manager: { query: jest.Mock; insert: jest.Mock };

    async function build(opts: { relayerGroups: any[]; providerGroups: any[]; sponsoredPairs: any[] }): Promise<void> {
        let callIdx = 0;
        const queue = [
            makeAggregateQbMock(opts.relayerGroups),
            makeAggregateQbMock(opts.providerGroups),
            makeAggregateQbMock(opts.sponsoredPairs),
        ];
        signEventRepo = { createQueryBuilder: jest.fn(() => queue[callIdx++]) };
        relayerRepo = {};
        manager = { query: jest.fn().mockResolvedValue([]), insert: jest.fn().mockResolvedValue({}) };
        dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                RelayerMartsService,
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: signEventRepo },
                { provide: getRepositoryToken(Relayer), useValue: relayerRepo },
                { provide: DataSource, useValue: dataSource },
            ],
        }).compile();

        service = moduleRef.get(RelayerMartsService);
    }

    it("deletes all relayers and skips insert when there are no aggregates", async () => {
        await build({ relayerGroups: [], providerGroups: [], sponsoredPairs: [] });

        const result = await service.rebuild();
        expect(result.relayers).toBe(0);
        expect(manager.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM "relayers"/));
        expect(manager.insert).not.toHaveBeenCalled();
    });

    it("rebuilds relayers from aggregates and merges provider mix + sponsored counts", async () => {
        await build({
            relayerGroups: [
                {
                    relayerAccountId: "Relayer.NEAR",
                    countId: "10",
                    minTs: new Date("2026-01-01"),
                    maxTs: new Date("2026-01-10"),
                    sumGas: "1234",
                },
            ],
            providerGroups: [
                { relayerAccountId: "Relayer.NEAR", providerType: "auth0", countId: "7" },
                { relayerAccountId: "Relayer.NEAR", providerType: "firebase", countId: "3" },
            ],
            sponsoredPairs: [
                { relayerAccountId: "Relayer.NEAR", sponsoredAccountId: "alice.near" },
                { relayerAccountId: "Relayer.NEAR", sponsoredAccountId: "bob.near" },
            ],
        });

        const result = await service.rebuild();
        expect(result.relayers).toBe(1);
        const inserted = manager.insert.mock.calls[0][1] as Array<Record<string, any>>;
        expect(inserted[0]).toMatchObject({
            accountId: "relayer.near",
            totalSignTransactions: 10,
            totalGasBurnt: "1234",
            totalSponsoredUniqueAccounts: 2,
            providerMixJson: { auth0: 7, firebase: 3 },
        });
    });

    it("falls back firstSeenAt/lastSeenAt to now() when nullable", async () => {
        await build({
            relayerGroups: [{ relayerAccountId: "r.near", countId: "1", minTs: null, maxTs: null, sumGas: null }],
            providerGroups: [],
            sponsoredPairs: [],
        });

        await service.rebuild();
        const inserted = manager.insert.mock.calls[0][1] as Array<Record<string, any>>;
        expect(inserted[0].firstSeenAt).toBeInstanceOf(Date);
        expect(inserted[0].lastSeenAt).toBeInstanceOf(Date);
    });
});
