import { Injectable, Logger } from '@nestjs/common';
import { hashDonation } from '@fundchain/shared';
import { AppError } from '../../common/app-error';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { BlockchainService } from '../blockchain/blockchain.service';
import { CampaignsService } from '../campaigns/campaigns.service';

export interface VerifyResult {
  donationId: string;
  campaignId: string;
  status: 'VERIFIED' | 'TAMPERED';
  currentPayload: string;
  currentHash: string;
  storedHash: string | null;
  onChainHash: string;
  campaignFrozen: boolean;
  checkedAt: Date;
}

/**
 * Integrity checker: hitung ulang hash dari data DB SAAT INI lalu bandingkan dengan hash on-chain.
 *   match    → VERIFIED
 *   mismatch → TAMPERED → campaign FROZEN → disbursement terkunci
 */
@Injectable()
export class IntegrityService {
  private readonly logger = new Logger('Integrity');

  constructor(
    private readonly prisma: PrismaService,
    private readonly blockchain: BlockchainService,
    private readonly campaigns: CampaignsService,
    private readonly audit: AuditService,
  ) {}

  async verifyDonation(donationId: string, actorId: string | null, ip: string | null = null): Promise<VerifyResult> {
    const donation = await this.prisma.donation.findUnique({
      where: { id: donationId },
      include: { donor: true, blockchain: true },
    });
    if (!donation) throw new AppError('DONATION_NOT_FOUND', 'Donasi tidak ditemukan.');
    if (donation.status !== 'PAID' || !donation.donatedAt || !donation.blockchain) {
      throw new AppError('BLOCKCHAIN_NOT_NOTARIZED', 'Donasi belum dibayar / belum masuk antrean notarisasi.');
    }
    if (donation.blockchain.status !== 'CONFIRMED') {
      throw new AppError('BLOCKCHAIN_NOT_NOTARIZED', `Notarisasi masih berstatus ${donation.blockchain.status}.`);
    }

    const onChainHash = await this.blockchain.readOnchainHash(donation.blockchain.onchainKey);
    if (this.blockchain.isZero(onChainHash)) {
      throw new AppError('BLOCKCHAIN_NOT_NOTARIZED', 'Hash donasi tidak ditemukan di blockchain.');
    }

    // Rebuild dari data DB sekarang — inilah yang mendeteksi manipulasi.
    const current = hashDonation({
      donationId: donation.id,
      integritySubjectId: donation.donor.integritySubjectId,
      amount: donation.amount,
      donatedAt: donation.donatedAt,
    });
    const match = current.hash.toLowerCase() === onChainHash.toLowerCase();
    const checkedAt = new Date();

    let campaignFrozen = false;
    await this.prisma.$transaction(async (tx) => {
      await tx.donation.update({
        where: { id: donation.id },
        data: { integrityStatus: match ? 'VERIFIED' : 'TAMPERED', lastCheckedAt: checkedAt },
      });
      await this.audit.log(
        {
          actorId,
          action: match ? 'INTEGRITY_VERIFIED' : 'INTEGRITY_TAMPERED',
          entityType: 'Donation',
          entityId: donation.id,
          metadata: { currentHash: current.hash, onChainHash, campaignId: donation.campaignId },
          ipAddress: ip,
        },
        tx,
      );
      if (!match) {
        const result = await this.campaigns.freeze(
          tx,
          donation.campaignId,
          `Integrity check: donasi ${donation.id} TAMPERED (hash DB ≠ hash on-chain)`,
          actorId,
          ip,
        );
        campaignFrozen = true;
        if (result.changed) this.logger.warn(`Campaign ${donation.campaignId} FROZEN karena donasi ${donation.id} TAMPERED`);
      }
    });

    return {
      donationId: donation.id,
      campaignId: donation.campaignId,
      status: match ? 'VERIFIED' : 'TAMPERED',
      currentPayload: current.payload,
      currentHash: current.hash,
      storedHash: donation.hash,
      onChainHash,
      campaignFrozen,
      checkedAt,
    };
  }

  /** Verifikasi semua donasi PAID yang sudah ternotarisasi (per campaign atau seluruh sistem). */
  async verifyMany(actorId: string | null, campaignId?: string, ip: string | null = null) {
    const donations = await this.prisma.donation.findMany({
      where: { campaignId, status: 'PAID', blockchain: { status: 'CONFIRMED' } },
      select: { id: true },
      orderBy: { donatedAt: 'asc' },
    });
    const results: VerifyResult[] = [];
    const errors: { donationId: string; code: string; message: string }[] = [];
    for (const { id } of donations) {
      try {
        results.push(await this.verifyDonation(id, actorId, ip));
      } catch (e) {
        if (e instanceof AppError && e.code === 'BLOCKCHAIN_RPC_ERROR') throw e;
        errors.push({ donationId: id, code: (e as AppError).code ?? 'INTERNAL_ERROR', message: (e as Error).message });
      }
    }
    const skipped = await this.prisma.donation.count({
      where: { campaignId, status: 'PAID', NOT: { blockchain: { status: 'CONFIRMED' } } },
    });
    const summary = {
      checked: results.length,
      verified: results.filter((r) => r.status === 'VERIFIED').length,
      tampered: results.filter((r) => r.status === 'TAMPERED').length,
      skippedNotNotarized: skipped,
      frozenCampaigns: [...new Set(results.filter((r) => r.campaignFrozen).map((r) => r.campaignId))],
    };
    // Satu entri ringkasan per aksi admin "Verifikasi semua / per campaign" (selain entri per donasi).
    await this.audit.log({
      actorId,
      action: 'INTEGRITY_BULK_VERIFY',
      entityType: campaignId ? 'Campaign' : 'System',
      entityId: campaignId ?? null,
      metadata: { scope: campaignId ? 'campaign' : 'all', ...summary, errors: errors.length },
      ipAddress: ip,
    });
    return { ...summary, results, errors };
  }
}
