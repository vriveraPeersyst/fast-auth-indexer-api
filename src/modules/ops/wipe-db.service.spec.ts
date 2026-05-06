import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { IndexerCheckpoint } from "../../database/entities/IndexerCheckpoint";
import { NearTransaction } from "../../database/entities/NearTransaction";
import { Relayer } from "../../database/entities/Relayer";
import { RelayerDapp } from "../../database/entities/RelayerDapp";
import { WipeDbService } from "./wipe-db.service";

describe("WipeDbService", () => {
    let service: WipeDbService;
    let manager: { delete: jest.Mock };
    let dataSource: { transaction: jest.Mock };

    beforeEach(async () => {
        manager = { delete: jest.fn().mockResolvedValue({ affected: 5 }) };
        dataSource = { transaction: jest.fn(async (cb: any) => cb(manager)) };

        const repoStub = {};
        const moduleRef: TestingModule = await Test.createTestingModule({
            providers: [
                WipeDbService,
                { provide: getRepositoryToken(FastAuthPublicKeyAccount), useValue: repoStub },
                { provide: getRepositoryToken(FastAuthSignEvent), useValue: repoStub },
                { provide: getRepositoryToken(NearTransaction), useValue: repoStub },
                { provide: getRepositoryToken(RelayerDapp), useValue: repoStub },
                { provide: getRepositoryToken(Relayer), useValue: repoStub },
                { provide: getRepositoryToken(IndexerCheckpoint), useValue: repoStub },
                { provide: DataSource, useValue: dataSource },
            ],
        }).compile();

        service = moduleRef.get(WipeDbService);
    });

    it("issues 6 deletes inside one transaction and returns per-table affected counts", async () => {
        const summary = await service.wipe();

        expect(dataSource.transaction).toHaveBeenCalledTimes(1);
        expect(manager.delete).toHaveBeenCalledTimes(6);
        expect(Object.keys(summary)).toEqual([
            "fastAuthPublicKeyAccount",
            "fastAuthSignEvent",
            "nearTransaction",
            "relayerDapp",
            "relayer",
            "indexerCheckpoint",
        ]);
        expect(summary.fastAuthSignEvent).toBe(5);
    });

    it("treats undefined `affected` as 0", async () => {
        manager.delete.mockResolvedValue({});
        const summary = await service.wipe();
        expect(summary.fastAuthSignEvent).toBe(0);
    });
});
