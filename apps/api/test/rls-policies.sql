-- Test RLS policy campaigns, langsung di PostgreSQL (dijalankan CI setelah semua migration).
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f apps/api/test/rls-policies.sql
-- Setiap pengecekan yang gagal memunculkan EXCEPTION → psql exit 1 → CI merah.
-- Semua berjalan di dalam transaksi yang di-ROLLBACK: database tidak berubah.

BEGIN;

-- Data uji: dua mahasiswa (Budi pemilik, Siti user lain) dan satu admin.
INSERT INTO "users" ("id", "email", "name", "role", "integrity_subject_id", "updated_at") VALUES
  ('rls-budi',  'budi@rls.test',  'Budi',  'STUDENT', 'STU-RLS-1', now()),
  ('rls-siti',  'siti@rls.test',  'Siti',  'STUDENT', 'STU-RLS-2', now()),
  ('rls-admin', 'admin@rls.test', 'Admin', 'ADMIN',   'ADM-RLS-1', now());

INSERT INTO "campaigns" ("id", "creator_id", "title", "description", "sdg_category", "target_amount", "deadline", "status", "updated_at") VALUES
  ('rls-draft',  'rls-budi', 'Draft Budi',  'd', 'SDG4', 100000, now() + interval '30 days', 'DRAFT',          now()),
  ('rls-review', 'rls-budi', 'Review Budi', 'd', 'SDG4', 100000, now() + interval '30 days', 'PENDING_REVIEW', now()),
  ('rls-active', 'rls-budi', 'Aktif Budi',  'd', 'SDG4', 100000, now() + interval '30 days', 'ACTIVE',         now());

CREATE TEMP TABLE rls_result (name text, ok boolean, detail text);
GRANT ALL ON rls_result TO fundchain_app;

CREATE OR REPLACE FUNCTION pg_temp.expect(name text, ok boolean, detail text) RETURNS void
LANGUAGE sql AS $$ INSERT INTO rls_result VALUES (name, ok, detail) $$;
GRANT EXECUTE ON FUNCTION pg_temp.expect(text, boolean, text) TO fundchain_app;

-- ── Pengunjung tanpa login ─────────────────────────────────────────────
SET LOCAL ROLE fundchain_app;
SELECT set_config('app.user_id', '', true);
SELECT pg_temp.expect('publik: hanya campaign ACTIVE yang terlihat',
  (SELECT array_agg("id" ORDER BY "id") FROM "campaigns" WHERE "id" LIKE 'rls-%') = ARRAY['rls-active'],
  (SELECT string_agg("id", ',') FROM "campaigns" WHERE "id" LIKE 'rls-%'));

-- ── 1. Policy user baca campaign publik + miliknya ─────────────────────
SELECT set_config('app.user_id', 'rls-siti', true);
SELECT pg_temp.expect('user lain: tidak melihat DRAFT/PENDING milik Budi',
  NOT EXISTS (SELECT 1 FROM "campaigns" WHERE "id" IN ('rls-draft', 'rls-review')), '');
SELECT pg_temp.expect('user lain: melihat campaign publik',
  EXISTS (SELECT 1 FROM "campaigns" WHERE "id" = 'rls-active'), '');

SELECT set_config('app.user_id', 'rls-budi', true);
SELECT pg_temp.expect('pemilik: melihat semua campaign miliknya',
  (SELECT count(*) FROM "campaigns" WHERE "id" LIKE 'rls-%') = 3, '');

-- ── 2. Policy user update campaign miliknya ────────────────────────────
WITH u AS (UPDATE "campaigns" SET "title" = 'Draft Budi (edit)' WHERE "id" = 'rls-draft' RETURNING 1)
SELECT pg_temp.expect('pemilik: bisa mengubah DRAFT miliknya', (SELECT count(*) FROM u) = 1, '');

WITH u AS (UPDATE "campaigns" SET "title" = 'x' WHERE "id" = 'rls-active' RETURNING 1)
SELECT pg_temp.expect('pemilik: tidak bisa mengubah campaign yang sudah ACTIVE', (SELECT count(*) FROM u) = 0, '');

SELECT set_config('app.user_id', 'rls-siti', true);
WITH u AS (UPDATE "campaigns" SET "title" = 'dibajak' WHERE "id" IN ('rls-draft', 'rls-active') RETURNING 1)
SELECT pg_temp.expect('user lain: tidak bisa mengubah campaign Budi', (SELECT count(*) FROM u) = 0, '');

SELECT set_config('app.user_id', 'rls-budi', true);
DO $$
BEGIN
  UPDATE "campaigns" SET "creator_id" = 'rls-siti' WHERE "id" = 'rls-draft';
  INSERT INTO rls_result VALUES ('pemilik: tidak bisa memindahkan kepemilikan', false, 'UPDATE lolos');
EXCEPTION WHEN insufficient_privilege THEN
  INSERT INTO rls_result VALUES ('pemilik: tidak bisa memindahkan kepemilikan', true, '');
END;
$$;

-- ── 3. Policy admin baca semua ─────────────────────────────────────────
SELECT set_config('app.user_id', 'rls-admin', true);
SELECT pg_temp.expect('admin: melihat semua campaign (termasuk DRAFT & PENDING_REVIEW)',
  (SELECT count(*) FROM "campaigns" WHERE "id" LIKE 'rls-%') = 3, '');
WITH u AS (UPDATE "campaigns" SET "status" = 'ACTIVE' WHERE "id" = 'rls-review' RETURNING 1)
SELECT pg_temp.expect('admin: bisa menyetujui (update) campaign', (SELECT count(*) FROM u) = 1, '');

-- Admin palsu: setting tidak bisa menaikkan peran, peran dibaca dari tabel users.
SELECT set_config('app.user_id', 'rls-siti', true);
SELECT set_config('app.role', 'ADMIN', true);
SELECT pg_temp.expect('setting app.role=ADMIN tidak membuat user biasa jadi admin',
  NOT EXISTS (SELECT 1 FROM "campaigns" WHERE "id" = 'rls-draft'), '');

-- Role Data API Supabase tetap tidak punya akses (bila ada).
RESET ROLE;
SELECT pg_temp.expect('anon/authenticated tidak punya hak di campaigns',
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = 'campaigns' AND grantee IN ('anon', 'authenticated')
  ), '');

-- ── Hasil ──────────────────────────────────────────────────────────────
SELECT CASE WHEN ok THEN '✓ ' ELSE '✗ ' END || name || CASE WHEN detail <> '' THEN ' (' || detail || ')' ELSE '' END AS hasil
  FROM rls_result;

DO $$
DECLARE failed int;
BEGIN
  SELECT count(*) INTO failed FROM rls_result WHERE NOT ok;
  IF failed > 0 THEN
    RAISE EXCEPTION '% test RLS gagal', failed;
  END IF;
END;
$$;

ROLLBACK;
