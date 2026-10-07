import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminAuditInterceptor } from './common/admin-audit.interceptor';
import { ActingUserGuard } from './common/auth';
import { env } from './common/env';
import { GLOBAL_RATE_LIMIT } from './common/rate-limits';
import { AllExceptionsFilter, ResponseInterceptor } from './common/http';
import { PrismaModule } from './common/prisma.service';
import { AuditService } from './modules/audit/audit.service';
import { BlockchainService } from './modules/blockchain/blockchain.service';
import { NotarizationWorker } from './modules/blockchain/notarization.worker';
import { AdminCampaignsController, CampaignsController } from './modules/campaigns/campaigns.controller';
import { CampaignsService } from './modules/campaigns/campaigns.service';
import { DisbursementsController } from './modules/disbursements/disbursements.controller';
import { DisbursementsService } from './modules/disbursements/disbursements.service';
import { DonationsController } from './modules/donations/donations.controller';
import { DonationsService } from './modules/donations/donations.service';
import { IntegrityController } from './modules/integrity/integrity.controller';
import { IntegrityService } from './modules/integrity/integrity.service';
import { MockPaymentAdapter } from './modules/payments/adapters/mock.adapter';
import { PakasirAdapter } from './modules/payments/adapters/pakasir.adapter';
import { PAYMENT_GATEWAY } from './modules/payments/adapters/payment-gateway';
import { PaymentsService } from './modules/payments/payments.service';
import { StorageService } from './modules/storage/storage.service';
import { UsersController } from './modules/users/users.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env'] }),
    ThrottlerModule.forRoot(GLOBAL_RATE_LIMIT),
    PrismaModule,
  ],
  controllers: [
    UsersController,
    CampaignsController,
    AdminCampaignsController,
    DonationsController,
    IntegrityController,
    DisbursementsController,
  ],
  providers: [
    AuditService,
    StorageService,
    CampaignsService,
    BlockchainService,
    IntegrityService,
    PaymentsService,
    DonationsService,
    DisbursementsService,
    NotarizationWorker,
    {
      provide: PAYMENT_GATEWAY,
      useFactory: () => (env().paymentProvider === 'pakasir' ? new PakasirAdapter() : new MockPaymentAdapter()),
    },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ActingUserGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
