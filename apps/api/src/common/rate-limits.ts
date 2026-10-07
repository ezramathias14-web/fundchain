/**
 * Batas request per IP untuk endpoint sensitif (di atas limit global 300/menit di AppModule).
 * Dipakai lewat dekorator `@Throttle(...)` dari @nestjs/throttler.
 *
 * Catatan serverless: storage throttler ada di memori tiap instance Vercel Function,
 * jadi limit ini "per instance". Lapisan kedua yang konsisten ada di Vercel Firewall
 * (lihat docs/INFRA_SECURITY.md → Rate limit).
 */
const perMinute = (limit: number) => ({ default: { limit, ttl: 60_000 } });

/** Limit global untuk semua endpoint (dipakai ThrottlerModule.forRoot di AppModule). */
export const GLOBAL_RATE_LIMIT = [{ name: 'default', ttl: 60_000, limit: 300 }];

export const RATE_LIMIT = {
  /** Login Google — mencegah brute force / penyalahgunaan endpoint token. */
  AUTH: perMinute(10),
  /** Membuat donasi (memanggil payment gateway). */
  DONATE: perMinute(10),
  /** Upload file (proposal & bukti milestone) — berat untuk DB storage. */
  UPLOAD: perMinute(10),
  /** Tulis data biasa: buat/edit/submit campaign, ajukan pencairan. */
  WRITE: perMinute(30),
  /** Simulasi pembayaran (dev tools). */
  DEV: perMinute(10),
  /** Verifikasi integritas (admin) — tiap panggilan membaca RPC blockchain. Spam → 429. */
  VERIFY: perMinute(10),
  /**
   * Webhook payment gateway. Keasliannya dijamin signature, tapi tetap dibatasi agar
   * webhook palsu bertubi-tubi tidak membanjiri DB & audit log. Gateway asli jauh di bawah ini.
   */
  WEBHOOK: perMinute(60),
} as const;
