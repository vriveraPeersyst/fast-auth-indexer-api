import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { Account } from "../../database/entities/Account";
import { FastAuthPublicKeyAccount } from "../../database/entities/FastAuthPublicKeyAccount";
import { FastAuthSignEvent } from "../../database/entities/FastAuthSignEvent";
import { CheckpointsModule } from "../common/checkpoints/checkpoints.module";
import { NearRpcModule } from "../common/near-rpc/near-rpc.module";
import { MpcDerivationService } from "./mpc-derivation.service";
import { PublicKeyAccountsCommand } from "./public-key-accounts.command";
import { PublicKeyAccountsService } from "./public-key-accounts.service";
import { PubkeyLookupService } from "./pubkey-lookup.service";

@Module({
    imports: [TypeOrmModule.forFeature([FastAuthSignEvent, FastAuthPublicKeyAccount, Account]), NearRpcModule, CheckpointsModule],
    providers: [MpcDerivationService, PubkeyLookupService, PublicKeyAccountsService, PublicKeyAccountsCommand],
    exports: [PublicKeyAccountsService],
})
export class PublicKeyAccountsModule {}
