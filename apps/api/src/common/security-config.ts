import { Logger } from '@nestjs/common';

/**
 * Pemeriksaan konfigurasi keamanan saat API start (production/staging).
 *
 * - Default: masalah hanya di-log sebagai warning (demo tetap jalan).
 * - SECURITY_STRICT=true: masalah level "error" membuat API gagal start,
 *   supaya deploy dengan secret yang lupa diisi tidak pernah naik.
 */
export type Severity = 'error' | 'warn';
export interface ConfigIssue {
  severity: Severity;
  key: string;
  message: string;
}

/** Kunci akun Hardhat bawaan — PUBLIK, siapa pun bisa memakainya. Tidak boleh dipakai di luar localhost. */
const HARDHAT_PUBLIC_KEYS = new Set([
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
]);
const DEFAULT_MOCK_WEBHOOK_SECRET = 'dev-mock-webhook-secret';
const MIN_SECRET_LENGTH = 32;

function weak(value: string | undefined): boolean {
  return !value || value.length < MIN_SECRET_LENGTH;
}

export function checkSecurityConfig(e: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  if (e.NODE_ENV !== 'production') return [];
  const issues: ConfigIssue[] = [];
  const add = (severity: Severity, key: string, message: string) => issues.push({ severity, key, message });

  if (weak(e.SESSION_SECRET)) {
    add('error', 'SESSION_SECRET', `wajib diisi (≥${MIN_SECRET_LENGTH} karakter acak); sekarang diturunkan dari DATABASE_URL`);
  }
  if (weak(e.FILE_URL_SECRET)) {
    add('error', 'FILE_URL_SECRET', `wajib diisi (≥${MIN_SECRET_LENGTH} karakter acak); sekarang diturunkan dari DATABASE_URL`);
  }
  if (e.SESSION_SECRET && e.SESSION_SECRET === e.FILE_URL_SECRET) {
    add('error', 'FILE_URL_SECRET', 'harus berbeda dari SESSION_SECRET');
  }
  if ((e.WORKER_MODE || 'interval') === 'on-demand' && weak(e.CRON_SECRET)) {
    add('error', 'CRON_SECRET', 'wajib diisi untuk Vercel Cron (WORKER_MODE=on-demand)');
  }

  const provider = e.PAYMENT_PROVIDER || 'mock';
  if (provider === 'mock') {
    if (!e.MOCK_WEBHOOK_SECRET || e.MOCK_WEBHOOK_SECRET === DEFAULT_MOCK_WEBHOOK_SECRET) {
      add('error', 'MOCK_WEBHOOK_SECRET', 'masih default (ada di repo publik) — siapa pun bisa memalsukan webhook "lunas"');
    }
    add('warn', 'PAYMENT_PROVIDER', 'masih "mock" — pembayaran tidak sungguhan (oke untuk demo)');
  } else if (provider === 'pakasir' && (!e.PAKASIR_API_KEY || !e.PAKASIR_PROJECT)) {
    add('error', 'PAKASIR_API_KEY', 'PAKASIR_API_KEY & PAKASIR_PROJECT wajib diisi');
  }

  const devToolsOn = e.ENABLE_DEV_TOOLS === undefined || e.ENABLE_DEV_TOOLS === '' || /^(1|true|yes|on)$/i.test(e.ENABLE_DEV_TOOLS);
  if (devToolsOn) {
    add('warn', 'ENABLE_DEV_TOOLS', 'aktif — tombol "Simulasi bayar" tersedia (matikan setelah demo)');
  }

  const network = e.BLOCKCHAIN_NETWORK || 'localhost';
  const relayer = (e.RELAYER_PRIVATE_KEY || '').toLowerCase();
  if (network !== 'localhost' && network !== 'hardhat') {
    if (!relayer) add('error', 'RELAYER_PRIVATE_KEY', `wajib diisi untuk jaringan ${network}`);
    else if (HARDHAT_PUBLIC_KEYS.has(relayer)) add('error', 'RELAYER_PRIVATE_KEY', 'memakai kunci publik Hardhat — ganti dengan wallet relayer sendiri');
  }

  if (!e.GOOGLE_CLIENT_ID) add('error', 'GOOGLE_CLIENT_ID', 'belum diisi — login tidak berfungsi');
  if (!e.ADMIN_EMAILS) add('warn', 'ADMIN_EMAILS', 'kosong — tidak ada yang otomatis menjadi admin');

  if ((e.WEB_URL || '').split(',').some((u) => /localhost|127\.0\.0\.1/.test(u))) {
    add('warn', 'WEB_URL', 'CORS masih mengizinkan localhost');
  }
  return issues;
}

/** Dipanggil saat bootstrap (main.ts & serverless.ts). */
export function enforceSecurityConfig(e: NodeJS.ProcessEnv = process.env): ConfigIssue[] {
  const issues = checkSecurityConfig(e);
  const logger = new Logger('SecurityConfig');
  for (const i of issues) {
    const line = `${i.key}: ${i.message}`;
    if (i.severity === 'error') logger.error(line);
    else logger.warn(line);
  }
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length && /^(1|true|yes|on)$/i.test(e.SECURITY_STRICT ?? '')) {
    throw new Error(`Konfigurasi keamanan tidak lolos (SECURITY_STRICT): ${errors.map((i) => i.key).join(', ')}`);
  }
  return issues;
}
