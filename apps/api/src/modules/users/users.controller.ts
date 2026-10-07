import { randomBytes } from 'node:crypto';
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AppError } from '../../common/app-error';
import { ClientIp, CurrentUser, type CurrentUserPayload, Public, Roles } from '../../common/auth';
import { env } from '../../common/env';
import { PrismaService } from '../../common/prisma.service';
import { RATE_LIMIT } from '../../common/rate-limits';
import { createSessionToken } from '../../common/session-token';
import { AuditService } from '../audit/audit.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { PaymentsService } from '../payments/payments.service';

class GoogleLoginDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  accessToken!: string;
}

@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly blockchain: BlockchainService,
    private readonly payments: PaymentsService,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }

  /** Konfigurasi publik untuk frontend (tanpa secret). */
  @Public()
  @Get('config')
  config() {
    const e = env();
    return {
      googleClientId: e.googleClientId,
      devTools: e.devTools,
      paymentProvider: this.payments.gateway.name,
      chain: this.blockchain.target(),
    };
  }

  /**
   * Login Google (popup GIS): frontend mengirim access token Google, server memverifikasi
   * audience & email, membuat/menemukan user, lalu menerbitkan token sesi.
   */
  @Public()
  @Throttle(RATE_LIMIT.AUTH)
  @Post('auth/google')
  async loginGoogle(@Body() dto: GoogleLoginDto, @ClientIp() ip: string | null) {
    const cfg = env();
    if (!cfg.googleClientId) throw new AppError('AUTH_UNAUTHENTICATED', 'Login Google belum dikonfigurasi di server.');

    const q = encodeURIComponent(dto.accessToken);
    const [info, profile] = await Promise.all([
      fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${q}`),
      fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${dto.accessToken}` } }),
    ]);
    if (!info.ok || !profile.ok) throw new AppError('AUTH_UNAUTHENTICATED', 'Token Google tidak valid.');
    const tokenInfo = (await info.json()) as { aud?: string; azp?: string };
    const g = (await profile.json()) as { email?: string; email_verified?: boolean; name?: string };
    if ((tokenInfo.aud ?? tokenInfo.azp) !== cfg.googleClientId || !g.email || g.email_verified !== true) {
      throw new AppError('AUTH_UNAUTHENTICATED', 'Akun Google tidak dapat diverifikasi.');
    }

    const email = g.email.toLowerCase();
    const name = g.name?.trim() || email.split('@')[0];
    const existing = await this.prisma.user.findUnique({ where: { email } });
    const isAdmin = cfg.adminEmails.includes(email);
    const user = existing
      ? isAdmin && existing.role !== 'ADMIN'
        ? await this.prisma.user.update({ where: { id: existing.id }, data: { role: 'ADMIN' } })
        : existing
      : await this.prisma.user.create({
          data: {
            email,
            name,
            role: isAdmin ? 'ADMIN' : 'STUDENT',
            integritySubjectId: `${isAdmin ? 'ADM' : 'STU'}-${randomBytes(5).toString('hex').toUpperCase()}`,
          },
        });

    // Jejak keamanan: setiap login, dan kenaikan peran menjadi ADMIN, tercatat di audit log.
    const promoted = !!existing && existing.role !== user.role;
    if (!existing || promoted) {
      await this.audit.log({
        actorId: user.id,
        action: promoted ? 'USER_ROLE_CHANGED' : 'USER_REGISTERED',
        entityType: 'User',
        entityId: user.id,
        metadata: promoted ? { from: existing!.role, to: user.role, reason: 'ADMIN_EMAILS' } : { role: user.role },
        ipAddress: ip,
      });
    }
    await this.audit.log({
      actorId: user.id,
      action: 'USER_LOGIN',
      entityType: 'User',
      entityId: user.id,
      metadata: { role: user.role, method: 'google' },
      ipAddress: ip,
    });

    return {
      token: createSessionToken(user.id),
      user: { id: user.id, name: user.name, email: user.email, role: user.role, integritySubjectId: user.integritySubjectId },
    };
  }

  @Get('me')
  me(@CurrentUser() user: CurrentUserPayload) {
    return user;
  }

  @Roles('ADMIN')
  @Get('admin/audit-logs')
  auditLogs(
    @Query('actorId') actorId?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.audit.list({ actorId, entityType, entityId, action, from, to, limit: limit ? Number(limit) : undefined, cursor });
  }

  @Roles('ADMIN')
  @Get('admin/stats')
  async stats() {
    const [campaigns, donations, raised, blockchain, integrity, disbursements, chain] = await Promise.all([
      this.prisma.campaign.groupBy({ by: ['status'], _count: true }),
      this.prisma.donation.groupBy({ by: ['status'], _count: true }),
      this.prisma.donation.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
      this.prisma.blockchainTransaction.groupBy({ by: ['status'], _count: true }),
      this.prisma.donation.groupBy({ by: ['integrityStatus'], where: { status: 'PAID' }, _count: true }),
      this.prisma.disbursement.groupBy({ by: ['status'], _count: true, _sum: { amount: true } }),
      this.blockchain.info(),
    ]);
    const toMap = (rows: { _count: number }[], key: string) =>
      Object.fromEntries(rows.map((r) => [(r as unknown as Record<string, string>)[key], r._count]));
    return {
      campaigns: toMap(campaigns, 'status'),
      donations: toMap(donations, 'status'),
      totalRaised: raised._sum.amount ?? 0,
      blockchain: toMap(blockchain, 'status'),
      integrity: toMap(integrity, 'integrityStatus'),
      disbursements: Object.fromEntries(
        disbursements.map((d) => [d.status, { count: d._count, amount: d._sum.amount ?? 0 }]),
      ),
      chain,
    };
  }
}
