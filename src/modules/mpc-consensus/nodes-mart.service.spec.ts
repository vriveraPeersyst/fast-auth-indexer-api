import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { MpcNode } from "../../database/entities/MpcNode";
import { MpcSignResponse } from "../../database/entities/MpcSignResponse";
import { NodesMartService } from "./nodes-mart.service";

function makeQueryBuilderMock(rows: any[] = []): any {
    const qb: any = {};
    qb.select = jest.fn(() => qb);
    qb.addSelect = jest.fn(() => qb);
    qb.groupBy = jest.fn(() => qb);
    qb.getRawMany = jest.fn().mockResolvedValue(rows);
    return qb;
}

describe("NodesMartService", () => {
    let service: NodesMartService;
    let responseRepo: { createQueryBuilder: jest.Mock };
    let nodeRepo: any;
    let dataSource: { transaction: jest.Mock };
    let manager: { query: jest.Mock; insert: jest.Mock };

    async function build(rawMany: any[]): Promise<void> {
        responseRepo = { createQueryBuilder: jest.fn(() => makeQueryBuilderMock(rawMany)) };
        nodeRepo = {};
        manager = { query: jest.fn().mockResolvedValue([]), insert: jest.fn().mockResolvedValue({}) };
        dataSource = {
            transaction: jest.fn(async (cb: any) => cb(manager)),
        };

        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                NodesMartService,
                { provide: getRepositoryToken(MpcSignResponse), useValue: responseRepo },
                { provide: getRepositoryToken(MpcNode), useValue: nodeRepo },
                { provide: DataSource, useValue: dataSource },
            ],
        }).compile();

        service = moduleRef.get(NodesMartService);
    }

    it("deletes all nodes and skips insert when there are no aggregates", async () => {
        await build([]);

        const result = await service.rebuild();

        expect(result).toBe(0);
        expect(manager.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM "mpc_nodes"/));
        expect(manager.insert).not.toHaveBeenCalled();
    });

    it("rebuilds the mart from aggregates and returns count", async () => {
        const min1 = new Date("2026-01-01");
        const max1 = new Date("2026-01-10");
        await build([
            { signerId: "node1.near", count: "42", minTs: min1, maxTs: max1 },
            { signerId: "node2.near", count: "7", minTs: null, maxTs: null },
        ]);

        const result = await service.rebuild();

        expect(result).toBe(2);
        expect(manager.query).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM "mpc_nodes"/));
        expect(manager.insert).toHaveBeenCalledWith(MpcNode, expect.any(Array));
        const insertedRows = manager.insert.mock.calls[0][1] as Array<Record<string, unknown>>;
        expect(insertedRows[0]).toMatchObject({ accountId: "node1.near", totalResponses: 42, firstSeenAt: min1, lastSeenAt: max1 });
        // Null min/max should be replaced with `now` (a Date instance).
        expect(insertedRows[1].firstSeenAt).toBeInstanceOf(Date);
        expect(insertedRows[1].lastSeenAt).toBeInstanceOf(Date);
    });
});
