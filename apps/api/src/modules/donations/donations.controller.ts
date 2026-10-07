import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional } from 'class-validator';
import { AppError } from '../../common/app-error';
import { type AuthedRequest, ClientIp, CurrentUser, type CurrentUserPayload, Public, Roles } from '../../common/auth';
import { env } from '../../common/env';
import { RATE_LIMIT } from '../../common/rate-limits';
import { MOCK_SIGNATURE_HEADER, signMockBody } from '../payments/adapters/mock.adapter';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../../common/prisma.service';
import { NotarizationWorker } from '../blockchain/notarization.worker';
import { DonationsService } from './donations.service';

class CreateDonationDto {
  @Type(() => Number)
  @IsInt({ message: 'Nominal harus bilangan bulat rupiah' })
  amount!: number;

  @IsOptional() @IsBoolean()
  anonymous?: boolean;
}

class SimulatePaymentDto {
  @IsOptional() @IsIn(['settlement', 'expire', 'failed'])
  outcome?: 'settlement' | 'expire' | 'failed';
}

@Controller()
export class DonationsController {
  constructor(
    private readonly donations: DonationsService,
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
    private readonly worker: NotarizationWorker,
  ) {}

  /** Serverless: picu worker notarisasi bila ada pekerjaan blockchain yang tertunda. */
  private kickIfPending(status: string | null | undefined) {
    if (status && status !== 'CONFIRMED' && status !== 'FAILED') this.worker.kick();
  }

  @Throttle(RATE_LIMIT.DONATE)
  @Post('campaigns/:id/donations')
  create(
    @Param('id', ParseUUIDPipe) campaignId: string,
    @Body() dto: CreateDonationDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    return this.donations.create(campaignId, dto, idempotencyKey, user, ip);
  }

  @Public()
  @Get('campaigns/:id/donations')
  listForCampaign(@Param('id', ParseUUIDPipe) campaignId: string) {
    return this.donations.listForCampaign(campaignId);
  }

  @Public()
  @Get('donations/:id')
  async detail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: CurrentUserPayload) {
    const d = await this.donations.detail(id, user);
    this.kickIfPending(d.blockchain?.status);
    return d;
  }

  @Public()
  @Get('donations/:id/blockchain')
  async blockchain(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user?: CurrentUserPayload) {
    const d = await this.donations.detail(id, user);
    return { donationId: d.id, hash: d.hash, integrityStatus: d.integrityStatus, ...d.blockchain };
  }

  @Get('me/donations')
  mine(@CurrentUser() user: CurrentUserPayload) {
    return this.donations.listMine(user);
  }

  @Roles('ADMIN')
  @Get('admin/donations')
  listAll(@Query('campaignId') campaignId?: string, @Query('integrityStatus') integrityStatus?: string) {
    return this.donations.listAll({ campaignId, integrityStatus });
  }

  /** Webhook payment gateway. Keaslian diverifikasi oleh adapter (signature / konfirmasi API). */
  @Public()
  @Throttle(RATE_LIMIT.WEBHOOK)
  @Post('webhooks/payment')
  @HttpCode(200)
  async webhook(@Req() req: AuthedRequest & { rawBody?: Buffer }, @ClientIp() ip: string | null) {
    const result = await this.payments.handleWebhook({ rawBody: req.rawBody, headers: req.headers, body: req.body }, ip);
    if (result.status === 'PAID') this.worker.kick();
    return result;
  }

  /**
   * DEV ONLY — simulasi gateway mengirim webhook bertanda tangan untuk donasi ini.
   * Melewati jalur yang persis sama dengan webhook asli.
   */
  @Throttle(RATE_LIMIT.DEV)
  @Post('dev/payments/:donationId/simulate')
  @HttpCode(200)
  async simulate(
    @Param('donationId', ParseUUIDPipe) donationId: string,
    @Body() dto: SimulatePaymentDto,
    @CurrentUser() user: CurrentUserPayload,
    @ClientIp() ip: string | null,
  ) {
    if (!env().devTools || this.payments.gateway.name !== 'mock') {
      throw new AppError('DEV_TOOLS_DISABLED', 'Simulasi pembayaran hanya tersedia dengan PAYMENT_PROVIDER=mock.');
    }
    const payment = await this.prisma.payment.findUnique({ where: { donationId }, include: { donation: true } });
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Pembayaran tidak ditemukan.');
    if (payment.donation.donorId !== user.id && user.role !== 'ADMIN') {
      throw new AppError('AUTH_FORBIDDEN', 'Hanya donor yang bisa mensimulasikan pembayaran ini.');
    }
    const rawBody = JSON.stringify({
      order_id: donationId,
      transaction_id: payment.externalPaymentId,
      status: dto.outcome ?? 'settlement',
      amount: payment.amount,
      payment_method: 'qris',
    });
    const result = await this.payments.handleWebhook(
      {
        rawBody: Buffer.from(rawBody),
        headers: { [MOCK_SIGNATURE_HEADER]: signMockBody(rawBody) },
        body: JSON.parse(rawBody),
      },
      ip,
    );
    if (result.status === 'PAID') this.worker.kick();
    return result;
  }
}
