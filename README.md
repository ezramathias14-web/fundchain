# FundChain

Platform fundraising mahasiswa BINUS dengan **blockchain sebagai immutable proof layer**.
Data operasional ada di database; setiap donasi yang lunas di-hash (Keccak-256) dan hash-nya dicatat di smart contract.
Integrity checker menghitung ulang hash dari database dan membandingkannya dengan hash on-chain. Jika berbeda → `TAMPERED` → campaign `FROZEN` → pencairan dana terkunci.

> **Mode demo tanpa login.** Pengguna dipilih lewat pemilih persona di pojok kanan atas (header `X-Acting-User`). Role tetap ditentukan backend dari database. Untuk produksi, ganti dengan Microsoft SSO BINUS (lihat `docs`/`FundChain_Complete_Planning_Docs`).

## Menjalankan

Butuh **Node 20+** dan **pnpm**. `apps/api/.env` **tidak ada di repo** (berisi password database) — setelah clone, pilih salah satu cara di bawah.

### Cara A — Hanya frontend (paling cepat, tanpa `.env`)

Web lokal memakai API production (`fundchain-api.vercel.app`). Cocok untuk mengerjakan tampilan.

```bash
pnpm install
```

```bash
pnpm dev:web:remote
```

Buka http://localhost:5173. Data yang dibuat masuk ke database production.

### Cara B — Full stack (API + blockchain lokal)

1. Salin `apps/api/.env.example` menjadi `apps/api/.env`.
2. Isi `DATABASE_URL` dan `DIRECT_URL` (minta ke pemilik project, atau pakai project Supabase sendiri — langkah di bawah).
3. Jalankan `pnpm install`, `pnpm bootstrap`, lalu `pnpm dev`.

Kalau `.env` belum diisi, API berhenti dengan pesan yang menjelaskan langkahnya. Gejalanya di web: "Tidak dapat terhubung ke server".

File upload (proposal & bukti pencairan) **hanya** disimpan di database (tabel `stored_files`) — tidak ada file di laptop, jadi semua orang dan Vercel melihat file yang sama. Pernah mengunggah dengan versi lama (file tertinggal di `apps/api/uploads`)? Jalankan `pnpm --filter @fundchain/api files:sync` di laptop tersebut.

### 1. Siapkan Supabase (untuk Cara B)

1. Buat project di [supabase.com](https://supabase.com) dan catat password database.
2. Dashboard → **Connect** → tab **ORMs** → **Prisma**. Salin dua connection string ke `apps/api/.env`:
   - `DATABASE_URL` → _Transaction pooler_ (port **6543**, dengan `?pgbouncer=true`)
   - `DIRECT_URL` → _Session pooler_ (port **5432**), dipakai untuk migrate
3. Password yang mengandung karakter khusus (`@ # / ?`) harus di-URL-encode.

Migration otomatis mengaktifkan **Row Level Security** di semua tabel. Data tidak bisa diakses lewat REST API Supabase memakai anon key; hanya backend (role postgres) yang bisa.

### 2. Install, migrate, jalankan

```bash
pnpm install
```

```bash
pnpm bootstrap
```

```bash
pnpm dev
```

`pnpm bootstrap` menjalankan migration ke Supabase dan mengisi data seed. Aman diulang: seed dilewati kalau campaign sudah ada. `pnpm dev` menjalankan sekaligus:

| Proses                          | Alamat                                            |
| ------------------------------- | ------------------------------------------------- |
| Hardhat node (blockchain lokal) | `http://127.0.0.1:8545`                           |
| Deploy `DonationRegistry`       | otomatis → `contracts/deployments/localhost.json` |
| API NestJS + worker notarisasi  | `http://localhost:3000/api/v1`                    |
| Web React                       | **http://localhost:5173**                         |

Blockchain lokal Hardhat kosong setiap restart. Worker otomatis menotarisasi ulang hash yang **tersimpan saat pembayaran**, sehingga data yang sudah dimanipulasi tetap terdeteksi.

### 3. Set Up Prisma (Optional / kalau error aja)

Buat yang baru clone terus udah jalanin semua step di atas tapi masih error karena koneksi API, bisa aja karena prisma belum ke install, caranya buka cmd di folder besar fundchain, lalu :

```bash
cd apps/api
```

```bash
pnpm prisma generate
```

setelah install, balik lagi ke folder besar fundchain dan jalan `pnpm dev` disana

## Skenario demo

1. Pilih **Budi Santoso** → _Campaign Saya_ → _Buat campaign_ → unggah `samples/proposal-contoh.pdf` → _Ajukan_.
2. Pilih **Admin BINUS** → _Admin → Review campaign_ → buka → _Setujui_.
3. Pilih **Siti Rahma** → buka campaign → _Donasi_ → _Simulasi bayar berhasil_. Lihat langkahnya: lunas → hash → tx → blok → terverifikasi.
4. Buka _Bukti donasi_: canonical payload, hash, tx hash, dan tombol hitung ulang hash di browser.
5. Manipulasi data langsung di database:
   ```bash
   pnpm demo:tamper --latest 900000
   ```
6. Admin → _Integritas_ → _Verifikasi semua donasi_ → **TAMPERED** → campaign **FROZEN**.
7. Budi coba _Ajukan pencairan_ → ditolak `CAMPAIGN_FROZEN`.

## Struktur

```
apps/api          NestJS + Prisma (PostgreSQL Supabase) + worker notarisasi in-process
apps/web          React + Vite + Tailwind + React Query
packages/shared   canonical payload & hash (sumber tunggal), konstanta, ABI, error codes
contracts         Hardhat + DonationRegistry.sol (AccessControl, admin ≠ relayer)
samples           PDF contoh untuk upload
FundChain_Complete_Planning_Docs   dokumen perencanaan (PRD, API spec, dll.)
```

## Keputusan implementasi vs dokumen planning

| Dokumen             | Implementasi                                                              | Alasan                                              |
| ------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| PostgreSQL          | PostgreSQL di Supabase (Prisma, pooler + direct URL)                      | Sesuai rencana deploy; RLS aktif di semua tabel     |
| Redis + BullMQ      | Tabel `blockchain_transactions` sebagai antrean (outbox) + worker polling | Tanpa Redis; retry/backoff/FAILED tetap sesuai spec |
| Microsoft SSO       | Persona switcher (`DEMO_MODE`)                                            | Permintaan: tanpa login                             |
| Midtrans            | `mock` (default) + adapter `pakasir`                                      | Sesuai keputusan Pakasir + Mock                     |
| Worker app terpisah | Worker di dalam proses API                                                | Satu perintah untuk jalan                           |

## Konfigurasi

Salin `apps/api/.env.example` → `apps/api/.env` (file ini tidak di-commit). Variabel penting:

- `PAYMENT_PROVIDER=mock|pakasir`, `PAKASIR_PROJECT`, `PAKASIR_API_KEY`. Webhook diarahkan ke `POST /api/v1/webhooks/payment`.
- `BLOCKCHAIN_NETWORK`, `BLOCKCHAIN_RPC_URL`, `CHAIN_ID`, `CONTRACT_ADDRESS`, `RELAYER_PRIVATE_KEY`, `BLOCKCHAIN_CONFIRMATIONS`.
- `DEMO_MODE`, `ENABLE_DEV_TOOLS`: **matikan di produksi.**

### Pindah ke Sepolia

1. Isi `contracts/.env` (`DEPLOYER_PRIVATE_KEY` = wallet admin, `RELAYER_ADDRESS` = wallet lain), lalu jalankan `pnpm --filter @fundchain/contracts deploy:sepolia`.
2. Di `apps/api/.env`: `BLOCKCHAIN_NETWORK=sepolia`, `CHAIN_ID=11155111`, `BLOCKCHAIN_RPC_URL=<rpc sepolia>`, `RELAYER_PRIVATE_KEY=<kunci relayer>`, `BLOCKCHAIN_CONFIRMATIONS=2`.
3. Isi relayer dengan Sepolia ETH dari faucet. Link Etherscan otomatis muncul di UI.

## Infra & security

CI/CD, staging, secret, backup, RLS, rate limit, dan audit log: lihat [`docs/INFRA_SECURITY.md`](docs/INFRA_SECURITY.md).

```
pnpm --filter @fundchain/api security:check   # cek RLS & audit log di database (butuh DIRECT_URL)
```

## Test

```bash
pnpm test
```

Mencakup: canonical hash (deterministik & avalanche), smart contract (9 test), state machine, aturan pencairan, dan signature webhook.

## Deploy (Vercel)

Live: **https://fundchain-web.vercel.app** (web) · **https://fundchain-api.vercel.app/api/v1** (API)

Dua project Vercel dari repo yang sama:

| Project         | Root Directory | Isi                                                                                                 |
| --------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `fundchain-web` | `apps/web`     | Static Vite; `/api/*` di-proxy ke `fundchain-api` (same-origin)                                     |
| `fundchain-api` | `apps/api`     | NestJS sebagai Vercel Function (`api/index.js` → `src/serverless.ts`), region `sin1` dekat Supabase |

Perbedaan mode serverless (diatur lewat env di project `fundchain-api`):

- `WORKER_MODE=on-demand`: tidak ada polling. Worker notarisasi dipicu setelah pembayaran lunas, saat halaman donasi melakukan polling, saat admin retry, dan oleh Vercel Cron harian (`/api/v1/cron/tick`).
- Upload disimpan di tabel `stored_files` (disk Vercel tidak permanen). Batas upload 4MB (batas body request Vercel 4,5MB).
- Blockchain: Sepolia (`BLOCKCHAIN_NETWORK=sepolia`, `CHAIN_ID=11155111`, `RELAYER_PRIVATE_KEY`, `CONTRACT_ADDRESS`).

Deploy ulang dari root repo:

```bash
vercel deploy --prod --project fundchain-api
```

```bash
vercel deploy --prod --project fundchain-web
```
