/**
 * E2E keamanan: rate limit endpoint sensitif & audit aksi admin.
 *
 * Menjalankan aplikasi Nest SUNGGUHAN (controller, guard, throttler, interceptor, filter error
 * yang sama dengan production) di port acak, dengan service/database di-mock.
 *
 *   pnpm --filter @fundchain/api test:e2e
 *
 * Kartu Trello: "Rate limit endpoint sensitif verify login webhook",
 * "Audit log service catat aksi admin", "Test spam verify → 429",
 * "Test user lain akses → 403" (lapisan API; lapisan database diuji test/rls-policies.sql).
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'e2e-session-secret-0123456789abcdef0123';
process.env.GOOGLE_CLIENT_ID = '';

import { configureApp } from '../src/app.setup';
import { AdminAuditInterceptor } from '../src/common/admin-audit.interceptor';
import { AppError } from '../src/common/app-error';
import { ActingUserGuard } from '../src/common/auth';
import { AllExceptionsFilter, ResponseInterceptor } from '../src/common/http';
import { PrismaService } from '../src/common/prisma.service';
import { GLOBAL_RATE_LIMIT, RATE_LIMIT } from '../src/common/rate-limits';
import { createSessionToken } from '../src/common/session-token';
import { AuditService, type AuditEntry } from '../src/modules/audit/audit.service';
import { BlockchainService } from '../src/modules/blockchain/blockchain.service';
import { CampaignsController } from '../src/modules/campaigns/campaigns.controller';
import { CampaignsService } from '../src/modules/campaigns/campaigns.service';
import { NotarizationWorker } from '../src/modules/blockchain/notarization.worker';
import { DonationsController } from '../src/modules/donations/donations.controller';
import { DonationsService } from '../src/modules/donations/donations.service';
import { IntegrityController } from '../src/modules/integrity/integrity.controller';
import { IntegrityService } from '../src/modules/integrity/integrity.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { StorageService } from '../src/modules/storage/storage.service';
import { UsersController } from '../src/modules/users/users.controller';

const ADMIN = { id: 'admin-1', email: 'admin@binus.ac.id', name: 'Admin', role: 'ADMIN', integritySubjectId: 'ADM-1' };
const STUDENT = { id: 'student-1', email: 'siti@binus.ac.id', name: 'Siti', role: 'STUDENT', integritySubjectId: 'STU-1' };
const BUDI = { id: 'budi-1', email: 'budi@binus.ac.id', name: 'Budi', role: 'STUDENT', integritySubjectId: 'STU-2' };
const DONATION_ID = '6fcbac70-58bf-443c-aa97-ac318ff6ff59';
const DRAFT_ID = '11111111-1111-4111-8111-111111111111';
const campaigns: Record<string, { id: string; creatorId: string; status: string; title: string; deadline: Date }> = {
  [DRAFT_ID]: { id: DRAFT_ID, creatorId: BUDI.id, status: 'DRAFT', title: 'Taman Baca Digital', deadline: new Date(Date.now() + 30 * 864e5) },
};

const auditLog: AuditEntry[] = [];
const auditMock = {
  log: async (entry: AuditEntry) => {
    auditLog.push(entry);
    return entry;
  },
};
const prismaMock = {
  user: { findUnique: async ({ where }: { where: { id?: string } }) => [ADMIN, STUDENT, BUDI].find((u) => u.id === where.id) ?? null },
  campaign: {
    findUnique: async ({ where }: { where: { id: string } }) => campaigns[where.id] ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(campaigns[where.id], Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined))),
  },
};
const integrityMock = {
  verifyMany: async () => ({ checked: 0, verified: 0, tampered: 0, skippedNotNotarized: 0, frozenCampaigns: [], results: [], errors: [] }),
  verifyDonation: async () => {
    throw new AppError('BLOCKCHAIN_NOT_NOTARIZED', 'Donasi belum dibayar / belum masuk antrean notarisasi.');
  },
};
const paymentsMock = { handleWebhook: async () => ({ status: 'IGNORED' }), gateway: { name: 'mock' } };
const noop = {};

@Module({
  imports: [ThrottlerModule.forRoot(GLOBAL_RATE_LIMIT)],
  controllers: [IntegrityController, DonationsController, UsersController, CampaignsController],
  providers: [
    { provide: PrismaService, useValue: prismaMock },
    { provide: AuditService, useValue: auditMock },
    { provide: IntegrityService, useValue: integrityMock },
    { provide: PaymentsService, useValue: paymentsMock },
    { provide: BlockchainService, useValue: noop },
    { provide: DonationsService, useValue: noop },
    { provide: StorageService, useValue: noop },
    CampaignsService,
    { provide: NotarizationWorker, useValue: { kick: () => undefined } },
    // Urutan & isi global provider sama persis dengan AppModule.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: ActingUserGuard },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AdminAuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class E2eModule {}

let app: INestApplication;
let base: string;
const adminToken = createSessionToken(ADMIN.id);
const studentToken = createSessionToken(STUDENT.id);
const budiToken = createSessionToken(BUDI.id);

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { success?: boolean; error?: { code: string } } | null;
  return { status: res.status, json };
}

/** Kirim `n` request berurutan, kembalikan daftar status HTTP. */
async function spam(n: number, method: string, path: string, token?: string, body?: unknown) {
  const statuses: number[] = [];
  let last: Awaited<ReturnType<typeof call>> | undefined;
  for (let i = 0; i < n; i++) {
    last = await call(method, path, token, body);
    statuses.push(last.status);
  }
  return { statuses, last: last! };
}

before(async () => {
  app = await NestFactory.create(E2eModule, { logger: false });
  configureApp(app); // prefix, helmet, CORS, ValidationPipe — sama dengan production
  await app.listen(0, '127.0.0.1');
  base = `${(await app.getUrl()).replace('[::1]', '127.0.0.1')}/api/v1`;
});

after(async () => {
  await app?.close();
});

describe('Rate limit endpoint sensitif', () => {
  it(`spam verifikasi integritas → request ke-${RATE_LIMIT.VERIFY.default.limit + 1} ditolak 429`, async () => {
    const limit = RATE_LIMIT.VERIFY.default.limit;
    const { statuses, last } = await spam(limit + 1, 'POST', '/admin/integrity/verify-all', adminToken);
    assert.deepEqual(statuses.slice(0, limit), Array(limit).fill(200), 'request dalam batas harus lolos');
    assert.equal(statuses[limit], 429);
    assert.equal(last.json?.error?.code, 'RATE_LIMITED');
  });

  it('limit verify per donasi terpisah dari verify-all dan juga 429 saat di-spam', async () => {
    const limit = RATE_LIMIT.VERIFY.default.limit;
    const { statuses } = await spam(limit + 1, 'POST', `/admin/donations/${DONATION_ID}/verify`, adminToken);
    assert.equal(statuses.filter((s) => s === 429).length, 1);
  });

  it(`spam login → request ke-${RATE_LIMIT.AUTH.default.limit + 1} ditolak 429`, async () => {
    const limit = RATE_LIMIT.AUTH.default.limit;
    const { statuses, last } = await spam(limit + 1, 'POST', '/auth/google', undefined, { accessToken: 'x'.repeat(20) });
    assert.ok(statuses.slice(0, limit).every((s) => s !== 429), 'request dalam batas tidak boleh 429');
    assert.equal(statuses[limit], 429);
    assert.equal(last.json?.error?.code, 'RATE_LIMITED');
  });

  it(`spam webhook → request ke-${RATE_LIMIT.WEBHOOK.default.limit + 1} ditolak 429`, async () => {
    const limit = RATE_LIMIT.WEBHOOK.default.limit;
    const { statuses } = await spam(limit + 1, 'POST', '/webhooks/payment', undefined, { order_id: DONATION_ID });
    assert.deepEqual(statuses.slice(0, limit), Array(limit).fill(200));
    assert.equal(statuses[limit], 429);
  });
});

describe('Audit log aksi admin', () => {
  it('mahasiswa yang mencoba endpoint admin → 403 dan tercatat ADMIN_ACCESS_DENIED', async () => {
    const before = auditLog.length;
    const res = await call('POST', '/admin/campaigns/c8980f6d-fccc-483d-a1c9-b02b75fab0d7/verify', studentToken);
    assert.equal(res.status, 403);
    const entry = auditLog.slice(before).find((e) => e.action === 'ADMIN_ACCESS_DENIED');
    assert.ok(entry, 'harus ada entri ADMIN_ACCESS_DENIED');
    assert.equal(entry.actorId, STUDENT.id);
    assert.match(String((entry.metadata as { route: string }).route), /admin\/campaigns/);
    assert.ok(entry.ipAddress, 'IP harus tercatat');
  });

  it('aksi admin yang gagal → tercatat ADMIN_ACTION_FAILED dengan kode error', async () => {
    // Endpoint retry (kuota rate limit-nya belum terpakai) dengan database mock yang gagal.
    const otherId = '0c68fd55-0000-4000-8000-000000000001';
    const before = auditLog.length;
    const res = await call('POST', `/admin/blockchain/${otherId}/retry`, adminToken);
    assert.ok(res.status >= 400);
    const entry = auditLog.slice(before).find((e) => e.action === 'ADMIN_ACTION_FAILED');
    assert.ok(entry, 'harus ada entri ADMIN_ACTION_FAILED');
    assert.equal(entry.actorId, ADMIN.id);
    assert.equal(entry.entityId, otherId);
    assert.equal((entry.metadata as { method: string }).method, 'POST');
  });

  it('request tanpa login ke endpoint admin → 401 dan tidak membanjiri audit log', async () => {
    const before = auditLog.length;
    const res = await call('POST', `/admin/blockchain/${DONATION_ID}/retry`);
    assert.equal(res.status, 401);
    assert.equal(auditLog.length, before);
  });
});

describe('Akses campaign milik user lain', () => {
  it('user lain mengubah campaign Budi → 403 CAMPAIGN_NOT_OWNED, data tidak berubah', async () => {
    const res = await call('PATCH', `/campaigns/${DRAFT_ID}`, studentToken, { title: 'Campaign dibajak orang lain' });
    assert.equal(res.status, 403);
    assert.equal(res.json?.error?.code, 'CAMPAIGN_NOT_OWNED');
    assert.equal(campaigns[DRAFT_ID].title, 'Taman Baca Digital');
  });

  it('user lain mengajukan review campaign Budi → 403', async () => {
    const res = await call('POST', `/campaigns/${DRAFT_ID}/submit`, studentToken);
    assert.equal(res.status, 403);
    assert.equal(res.json?.error?.code, 'CAMPAIGN_NOT_OWNED');
  });

  it('user lain membuka DRAFT Budi → 404 (keberadaan campaign non-publik tidak dibocorkan)', async () => {
    const res = await call('GET', `/campaigns/${DRAFT_ID}`, studentToken);
    assert.equal(res.status, 404);
  });

  it('tanpa login mengubah campaign → 401', async () => {
    const res = await call('PATCH', `/campaigns/${DRAFT_ID}`, undefined, { title: 'Tanpa login mencoba' });
    assert.equal(res.status, 401);
  });

  it('pemilik mengubah campaign miliknya → 200', async () => {
    const res = await call('PATCH', `/campaigns/${DRAFT_ID}`, budiToken, { title: 'Taman Baca Digital Kasih Bunda' });
    assert.equal(res.status, 200);
    assert.equal(campaigns[DRAFT_ID].title, 'Taman Baca Digital Kasih Bunda');
  });
});
