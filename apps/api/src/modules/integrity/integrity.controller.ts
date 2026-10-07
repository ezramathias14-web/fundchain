import { Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../../common/app-error';
import { ClientIp, CurrentUser, type CurrentUserPayload, Public, Roles } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { env } from '../../common/env';
import { RATE_LIMIT } from '../../common/rate-limits';
import { BlockchainService } from '../blockchain/blockchain.service';
import { NotarizationWorker } from '../blockchain/notarization.worker';
import { IntegrityService } from './integrity.service';

@Controller()
export class IntegrityController {
  constructor(
    private readonly integrity: IntegrityService,
    private readonly blockchain: BlockchainService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly worker: NotarizationWorker,
  ) {}

  /**
   * Cron (Vercel Cron → GET dengan header Authorization: Bearer <CRON_SECRET>).
   * Jaring pengaman serverless: memproses antrean notarisasi, pembayaran kedaluwarsa,
   * dan campaign yang lewat deadline.
   */
  @Public()
  @SkipThrottle()
  @Get('cron/tick')
  async cron(@Headers('authorization') auth?: string) {
    const secret = env().cronSecret;
    const expected = Buffer.from(`Bearer ${secret}`);
    const given = Buffer.from(auth ?? '');
    if (!secret || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new AppError('AUTH_UNAUTHENTICATED', 'Cron secret tidak valid.');
    }
    await this.worker.tick();
    return { ok: true, at: new Date().toISOString() };
  }

  @Public()
  @Get('blockchain/info')
  info() {
    return this.blockchain.info();
  }

  @Roles('ADMIN')
  @Throttle(RATE_LIMIT.VERIFY)
  @Post('admin/donations/:id/verify')
  @HttpCode(200)
  verifyDonation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.integrity.verifyDonation(id, admin.id, ip);
  }

  @Roles('ADMIN')
  @Throttle(RATE_LIMIT.VERIFY)
  @Post('admin/campaigns/:id/verify')
  @HttpCode(200)
  verifyCampaign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.integrity.verifyMany(admin.id, id, ip);
  }

  @Roles('ADMIN')
  @Throttle(RATE_LIMIT.VERIFY)
  @Post('admin/integrity/verify-all')
  @HttpCode(200)
  verifyAll(@CurrentUser() admin: CurrentUserPayload, @ClientIp() ip: string | null) {
    return this.integrity.verifyMany(admin.id, undefined, ip);
  }

  /** Antrekan ulang notarisasi yang FAILED. Hash yang dikirim tetap hash saat settlement. */
  @Roles('ADMIN')
  @Throttle(RATE_LIMIT.VERIFY)
  @Post('admin/blockchain/:donationId/retry')
  @HttpCode(200)
  async retry(
    @Param('donationId', ParseUUIDPipe) donationId: string,
    @CurrentUser() admin: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    const { count } = await this.prisma.blockchainTransaction.updateMany({
      where: { donationId, status: 'FAILED' },
      data: { status: 'QUEUED', retryCount: 0, lastError: null, nextAttemptAt: new Date() },
    });
    if (count === 0) throw new AppError('BLOCKCHAIN_INVALID_STATUS', 'Hanya notarisasi FAILED yang bisa diulang.');
    await this.audit.log({
      actorId: admin.id,
      action: 'BLOCKCHAIN_RETRY_REQUESTED',
      entityType: 'Donation',
      entityId: donationId,
      ipAddress: ip,
    });
    this.worker.kick();
    return { donationId, status: 'QUEUED' };
  }
}
