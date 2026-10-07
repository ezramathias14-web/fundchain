# FundChain — Infra & Security

Penanggung jawab: **Ezra (BE, infra & security)** · Terakhir diperbarui: 6 Okt 2026

Cakupan: CI/CD, staging, secret, backup, RLS Supabase, rate limit, audit log.

## Ringkasan status

| Area | Status | Isi |
|---|---|---|
| CI/CD | ✅ Siap, perlu diaktifkan | `ci.yml` (typecheck, test, build, cek bundle), `migrate.yml` (migration otomatis), deploy app via Vercel Git |
| Staging | 🟡 Kode siap, butuh resource | `VITE_API_BASE_URL` untuk web staging; butuh Supabase + 2 project Vercel staging |
| Secret | ✅ History bersih (gitleaks) | `security.yml` scan tiap PR; cek konfigurasi production saat API start (`security-config.ts`) |
| Backup | ✅ Siap, perlu secret | `backup.yml` harian 02:00 WIB, terenkripsi AES-256, **uji restore otomatis** |
| RLS Supabase | ✅ Aktif + diperkuat | RLS semua tabel, `REVOKE` anon/authenticated, `security:check` di CI & mingguan |
| Rate limit | ✅ Diperketat | Limit per endpoint sensitif + rekomendasi Vercel Firewall |
| Audit log | ✅ Append-only | Trigger DB menolak UPDATE/DELETE/TRUNCATE di `audit_logs` |

---

## 1. Lingkungan

| | Local | Staging | Production (demo) |
|---|---|---|---|
| Branch | apa saja | `develop` | `main` |
| Web | `localhost:5173` | Vercel `fundchain-web-staging` | `fundchain-web.vercel.app` |
| API | `localhost:3000` | Vercel `fundchain-api-staging` | `fundchain-api.vercel.app` |
| Database | Supabase dev / Postgres lokal | **Supabase project terpisah** | Supabase production |
| Blockchain | Hardhat lokal | Sepolia, **relayer wallet terpisah** | Sepolia, relayer production |
| Payment | mock | mock | mock (demo) → Pakasir |
| `ENABLE_DEV_TOOLS` | true | true | true selama demo, **false setelahnya** |

Aturan: staging **tidak boleh** memakai database atau relayer production. `pnpm demo:tamper` hanya dijalankan di local/staging, karena script itu sengaja merusak data.

### Cara membuat staging (sekali saja)

1. **Supabase**: buat project baru `fundchain-staging` (region Singapore). Isi `DATABASE_URL` dan `DIRECT_URL` dari Connect → ORMs → Prisma.
2. **Vercel API staging**: Add New Project → import repo yang sama → Root Directory `apps/api` → beri nama `fundchain-api-staging`. Di Settings → Git, set *Production Branch* = `develop`. Isi env seperti production, tapi pakai nilai staging (DB staging, relayer staging, secret baru).
3. **Vercel web staging**: project `fundchain-web-staging`, Root `apps/web`, Production Branch `develop`. Set env:
   - `VITE_API_BASE_URL=https://fundchain-api-staging.vercel.app/api/v1`
   - Di API staging, set `WEB_URL=https://fundchain-web-staging.vercel.app` (dipakai untuk CORS).
4. **Google OAuth**: tambahkan domain web staging ke *Authorized JavaScript origins*.
5. **GitHub**: buat environment `staging` berisi secret `DIRECT_URL` (milik staging).
6. Migration staging berjalan sendiri lewat `migrate.yml` setiap ada push ke `develop` yang mengubah migration.

---

## 2. CI/CD

```
feature/* ──PR──▶ develop ──PR──▶ main
   │                 │               │
   │  CI + Security  │  Vercel →     │  Vercel → production
   │  (wajib hijau)  │  staging      │  migrate.yml → production (butuh approval)
   │                 │  migrate.yml → staging
```

| Workflow | Kapan | Isi |
|---|---|---|
| `ci.yml` | setiap PR & push `main`/`develop` | install (lockfile wajib cocok), `prisma validate`, compile contract, typecheck, `pnpm test`, build API & web, cek tidak ada secret di bundle web; job kedua menjalankan **semua migration dari nol** di Postgres sementara (meniru role Supabase), lalu `security:check` dan uji audit log append-only |
| `security.yml` | PR, push, tiap Senin 08:00 WIB | gitleaks (seluruh history), `pnpm audit --prod` (high/critical), cek RLS di DB production (jadwal/manual saja) |
| `migrate.yml` | push ke `develop`/`main` yang mengubah `prisma/` | `prisma migrate deploy` ke staging/production, lalu `security:check` |
| `backup.yml` | harian 02:00 WIB + manual | lihat bagian 4 |
| Dependabot | mingguan | PR update dependency (minor/patch digabung) |

Deploy aplikasi tetap lewat **integrasi Git Vercel** (push → build otomatis), bukan dari GitHub Actions, sehingga token Vercel tidak perlu disimpan di GitHub.

### Langkah aktivasi (GitHub, sekali saja, oleh pemilik repo)

1. Settings → Branches → tambah rule untuk `main` (dan `develop`):
   - Require a pull request before merging
   - Require status checks: `Typecheck · test · build`, `Migration & RLS check (Postgres sementara)`, `Secret scanning (gitleaks, seluruh history)`
2. Settings → Environments:
   - `production`: secret `DIRECT_URL`, `BACKUP_PASSPHRASE`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Aktifkan **Required reviewers** (ketua + Ezra).
   - `staging`: secret `DIRECT_URL` milik staging.
3. Settings → Code security → aktifkan **Secret scanning** dan **Push protection** (gratis untuk repo publik).
4. Vercel → kedua project production → Settings → Git: pastikan *Production Branch* = `main`.

---

## 3. Secret

Semua secret hanya disimpan di **Vercel Environment Variables** (runtime) dan **GitHub Environments** (CI). Tidak ada secret yang di-commit: `.env` ada di `.gitignore`, dan gitleaks memindai setiap PR. Hasil scan seluruh history pada 6 Okt 2026: **tidak ada kebocoran**.

| Secret | Disimpan di | Cara membuat | Catatan |
|---|---|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Vercel (api), GitHub env | Supabase → Connect | Beda per environment |
| `SESSION_SECRET` | Vercel (api) | `openssl rand -hex 32` | **Wajib.** Kalau kosong, kode menurunkannya dari `DATABASE_URL`, sehingga mengganti password DB akan me-logout semua user |
| `FILE_URL_SECRET` | Vercel (api) | `openssl rand -hex 32` | Wajib, harus beda dari `SESSION_SECRET` |
| `CRON_SECRET` | Vercel (api) | `openssl rand -hex 32` | Dipakai Vercel Cron |
| `MOCK_WEBHOOK_SECRET` | Vercel (api) | `openssl rand -hex 32` | **Wajib diganti.** Nilai default publik di repo, jadi siapa pun bisa memalsukan webhook "lunas" |
| `RELAYER_PRIVATE_KEY` | Vercel (api) saja | wallet baru khusus relayer | Isi saldo secukupnya (≈0,05 ETH Sepolia). Jangan pernah sama dengan wallet admin/deployer |
| `DEPLOYER_PRIVATE_KEY` | Lokal pemegang admin saja | wallet terpisah | Tidak pernah masuk Vercel/GitHub |
| `PAKASIR_API_KEY` | Vercel (api) | dashboard Pakasir | |
| `GOOGLE_CLIENT_ID` | Vercel (api) | Google Cloud Console | Bukan rahasia, tapi per environment |
| `BACKUP_PASSPHRASE` | GitHub env `production` + password manager tim | `openssl rand -base64 32` | Kalau hilang, backup tidak bisa dibuka |

### Pengecekan otomatis saat API start

`apps/api/src/common/security-config.ts` memeriksa konfigurasi production. Error yang ditandai: secret kosong/pendek, `MOCK_WEBHOOK_SECRET` default, kunci Hardhat publik dipakai di Sepolia, dan `GOOGLE_CLIENT_ID` kosong. Warning yang ditandai: dev tools aktif, CORS mengizinkan localhost.

- Default: hanya tercatat di log Vercel (`SecurityConfig`). Cek log setelah deploy.
- `SECURITY_STRICT=true`: API **menolak start** kalau ada error. Aktifkan di production setelah semua secret di atas diisi.

### Rotasi

- **Relayer key bocor**: admin memanggil `revokeRole(RELAYER_ROLE, relayerLama)` dan `grantRole(RELAYER_ROLE, relayerBaru)` di `DonationRegistry` (contract tidak perlu deploy ulang). Lalu ganti `RELAYER_PRIVATE_KEY` di Vercel dan redeploy.
- **Password DB bocor**: reset di Supabase → perbarui `DATABASE_URL`/`DIRECT_URL` di Vercel dan GitHub.
- **`SESSION_SECRET` diganti**: semua sesi login otomatis tidak berlaku (user perlu login ulang).

---

## 4. Backup & restore

`backup.yml` berjalan setiap hari pukul 02:00 WIB:

1. `pg_dump` schema `public` dari Supabase production (format custom, terkompresi).
2. **Uji restore** ke Postgres sementara, lalu jumlah baris tiap tabel ditulis di *Summary* job. Backup yang tidak bisa di-restore membuat job gagal (merah).
3. Enkripsi AES-256 (`gpg --symmetric`). Ini wajib karena repo publik.
4. Upload sebagai artifact, disimpan 30 hari.

### Restore (darurat)

```bash
# 1. Unduh artifact fundchain-db-<tanggal> dari tab Actions → Backup database
gpg --decrypt fundchain-<tanggal>.dump.gpg > fundchain.dump    # masukkan BACKUP_PASSPHRASE
sha256sum -c fundchain-<tanggal>.sha256                         # opsional, cek integritas

# 2. Restore ke project Supabase BARU (jangan timpa production yang sedang diselidiki).
#    Role untuk policy RLS harus dibuat dulu (anon & authenticated sudah ada di Supabase):
psql "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  -c "CREATE ROLE fundchain_app NOLOGIN NOINHERIT; GRANT fundchain_app TO CURRENT_USER;"
pg_restore --no-owner --no-privileges --clean --if-exists \
  -d "postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres" \
  fundchain.dump
# Hak tabel tidak ikut di-restore (--no-privileges); pasang lagi hak role aplikasi:
psql "<url yang sama>" -c "GRANT USAGE ON SCHEMA public TO fundchain_app; GRANT SELECT, UPDATE ON campaigns TO fundchain_app;"

# 3. Verifikasi, lalu arahkan DATABASE_URL/DIRECT_URL di Vercel ke project hasil restore
pnpm --filter @fundchain/api security:check
```

Untuk FundChain, kehilangan data DB tidak menghapus bukti di blockchain: hash setiap donasi tetap ada di Sepolia. Setelah restore, jalankan **Verifikasi semua donasi** di admin. Donasi yang datanya tidak cocok akan langsung terlihat sebagai `TAMPERED`.

---

## 5. RLS Supabase

- Migration `init` & `stored_files` mengaktifkan **RLS tanpa policy** di semua tabel. Akibatnya, Data API Supabase (anon key) tidak bisa membaca apa pun, sedangkan backend (role `postgres`) tetap bisa.
- Migration `20261006000000_security_hardening` menambahkan `REVOKE ALL` dari `anon` & `authenticated`, termasuk default privileges untuk tabel baru. Jadi aksesnya tertutup dua lapis.
- `pnpm --filter @fundchain/api security:check` memeriksa:
  - RLS aktif di semua tabel `public`
  - tidak ada policy yang membuka akses ke anon/authenticated
  - role tersebut tidak punya hak tabel
  - trigger audit log terpasang
  - (bila `SUPABASE_URL` + `SUPABASE_ANON_KEY` diisi) uji langsung lewat Data API: setiap tabel harus kosong/ditolak
- Pemeriksaan ini berjalan di CI (DB sementara), setelah setiap migration, dan setiap Senin di production.

### Policy RLS campaigns

Login FundChain memakai Google + token sesi milik API, bukan Supabase Auth. Karena itu policy tidak memakai `auth.uid()`. Identitas dibawa per transaksi lewat `app.user_id`, dan query dijalankan sebagai role `fundchain_app` (migration `20261006010000_rls_campaign_policies`). Peran admin selalu dibaca dari tabel `users` lewat fungsi `app_is_admin()`, jadi tidak bisa dipalsukan lewat setting.

| Policy | Siapa | Aturan |
|---|---|---|
| `campaigns_select_public` | semua, termasuk tanpa login | baca campaign `ACTIVE` / `FROZEN` / `COMPLETED` |
| `campaigns_select_own` | pembuat | baca semua campaign miliknya (DRAFT, PENDING_REVIEW, REJECTED juga) |
| `campaigns_update_own` | pembuat | ubah campaign miliknya hanya saat `DRAFT` / `REJECTED`; kepemilikan tidak bisa dipindah |
| `campaigns_select_admin` | admin | baca semua campaign |
| `campaigns_update_admin` | admin | ubah status (review, freeze, unfreeze) |

Cara backend memakai policy ini (di dalam satu transaksi):

```sql
SELECT set_config('app.user_id', '<id user>', true);
SET LOCAL ROLE fundchain_app;
-- query campaign di sini otomatis tersaring policy
```

Pembuktian, di dua lapis:
- **Database**: `apps/api/test/rls-policies.sql` berisi 12 pengecekan (publik, pemilik, user lain, admin, admin palsu, anon). Dijalankan di CI dan setelah setiap migration, dan selalu di-ROLLBACK.
- **API**: `apps/api/test/security.e2e.ts`. User lain yang mengubah atau mengajukan campaign orang → **403 `CAMPAIGN_NOT_OWNED`**. User lain yang membuka DRAFT orang → 404, supaya keberadaan campaign non-publik tidak bocor. Tanpa login → 401.

**Aturan untuk anggota tim**: setiap tabel baru di migration **wajib** diakhiri `ALTER TABLE "<nama>" ENABLE ROW LEVEL SECURITY;`. Kalau lupa, CI akan merah.

---

## 6. Rate limit

Limit global: 300 request/menit per IP. Endpoint sensitif diperketat (`apps/api/src/common/rate-limits.ts`):

| Endpoint | Limit / menit / IP |
|---|---|
| `POST /auth/google` | 10 |
| `POST /campaigns/:id/donations` | 10 |
| `POST /campaigns/:id/documents`, `POST /campaigns/:id/disbursements` (upload) | 10 |
| `POST /dev/payments/:id/simulate` | 10 |
| `POST/PATCH /campaigns`, `POST /campaigns/:id/submit` | 30 |
| Verifikasi integritas admin (`verify`, `verify-all`, `retry`) | 10 |
| `POST /webhooks/payment` | 60 (signature tetap wajib) |
| `GET /cron/tick` | dikecualikan (dilindungi `CRON_SECRET`) |

Respons saat limit terlampaui: HTTP **429** `{ "success": false, "error": { "code": "RATE_LIMITED" } }`.
Dibuktikan otomatis oleh `apps/api/test/security.e2e.ts` (bagian dari `pnpm test` dan CI). Demo manual: `apps/api/scripts/spam-verify.sh`.

Keterbatasan: di Vercel serverless, counter disimpan di memori tiap instance, sehingga limit berlaku per instance. Lapisan kedua yang konsisten bisa dibuat di **Vercel → fundchain-api → Firewall → Add Rule**:

- Rate limit `Path starts with /api/v1/auth` → 20 req/menit/IP → Deny (429)
- Rate limit `Path starts with /api/v1/` → 600 req/menit/IP → Deny (429)

---

## 7. Audit log

- Event yang dicatat: login (`USER_LOGIN`), user baru & kenaikan peran ke ADMIN (`USER_REGISTERED`, `USER_ROLE_CHANGED`), campaign (buat/ubah/review/bekukan), pembayaran & webhook (termasuk yang ditolak dan selisih nominal), notarisasi blockchain, verifikasi integritas, pencairan. Semua lengkap dengan aktor, waktu, dan IP. Bisa dilihat di Admin → Audit log (filter per aksi/entitas).
- **Aksi admin**: yang berhasil dicatat dengan event domain (`CAMPAIGN_APPROVED/REJECTED`, `CAMPAIGN_FROZEN/UNFROZEN`, `DISBURSEMENT_*`, `INTEGRITY_VERIFIED/TAMPERED`, `INTEGRITY_BULK_VERIFY`, `BLOCKCHAIN_RETRY_REQUESTED`). Yang **gagal** dicatat `ADMIN_ACTION_FAILED` (interceptor `admin-audit.interceptor.ts`, berisi route + kode error). User non-admin yang mencoba endpoint admin dicatat `ADMIN_ACCESS_DENIED`. Request tanpa login tidak dicatat, supaya audit log tidak bisa dibanjiri.
- **Append-only di level database**: trigger `audit_logs_no_update_delete` dan `audit_logs_no_truncate` menolak UPDATE/DELETE/TRUNCATE, termasuk dari role `postgres`. Orang dalam yang membuka SQL editor tidak bisa menghapus jejak tanpa `DROP TRIGGER`, dan langkah itu sendiri terlihat oleh `security:check`. Satu-satunya UPDATE yang diizinkan adalah `actor_id → NULL` saat user dihapus (FK `ON DELETE SET NULL`).
- Kenapa tidak ada INSERT palsu yang menipu? Audit log mencatat *keputusan*. *Kebenaran data donasi* tetap dibuktikan oleh hash on-chain (integrity checker).

---

## 8. Risiko yang masih terbuka (backlog)

| Risiko | Dampak | Rencana |
|---|---|---|
| `ENABLE_DEV_TOOLS` aktif di production (tombol simulasi bayar) | Donatur bisa menandai donasinya sendiri "lunas" tanpa uang | Sengaja untuk demo; set `false` saat memakai Pakasir sungguhan |
| Fallback secret dari `DATABASE_URL` | Ganti password DB = semua sesi dan link file berubah | Isi `SESSION_SECRET` & `FILE_URL_SECRET`, lalu aktifkan `SECURITY_STRICT=true` |
| Throttler in-memory di serverless | Limit bisa dilewati dengan memicu banyak instance | Vercel Firewall rule (bagian 6) |
| Backup hanya schema `public`, tanpa PITR | Data antara backup terakhir dan insiden bisa hilang (≤24 jam) | Cukup untuk demo; upgrade Supabase Pro (PITR) untuk produksi sungguhan |
| `.mcp.json` berisi project ref Supabase | Rendah (ref bukan secret) | Biarkan, atau pindahkan ke konfigurasi lokal |
