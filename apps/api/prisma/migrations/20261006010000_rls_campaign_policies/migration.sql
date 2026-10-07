-- RLS policy untuk tabel campaigns (kartu Trello "Policy RLS").
--
-- Model akses FundChain: login memakai Google + token sesi milik API (bukan Supabase Auth),
-- jadi auth.uid() tidak dipakai. Identitas dibawa per transaksi lewat setting
--   app.user_id  → id user yang sedang login (diset backend dengan set_config(..., true))
-- dan query dijalankan sebagai role `fundchain_app` (SET LOCAL ROLE). Peran ADMIN selalu
-- dibaca dari tabel users, tidak pernah dari input/setting (BR-AUTH-002).
--
-- Role anon/authenticated (Data API Supabase) TETAP tanpa akses sama sekali.
--
--   1. Policy user baca campaign publik   → status ACTIVE / FROZEN / COMPLETED
--   2. Policy user update campaign miliknya → hanya creator, hanya saat DRAFT / REJECTED
--   3. Policy admin baca semua             → semua status (+ update untuk review/freeze)

-- Role aplikasi (tanpa login) yang dipakai backend lewat SET LOCAL ROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fundchain_app') THEN
    CREATE ROLE fundchain_app NOLOGIN NOINHERIT;
  END IF;
END;
$$;
GRANT fundchain_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO fundchain_app;
GRANT SELECT, UPDATE ON "campaigns" TO fundchain_app;

-- Identitas request saat ini (NULL bila tidak ada user).
CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')
$$;

-- Admin ditentukan dari database. SECURITY DEFINER agar bisa membaca users
-- tanpa memberi fundchain_app akses ke tabel users.
CREATE OR REPLACE FUNCTION app_is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM "users" WHERE "id" = app_current_user_id() AND "role" = 'ADMIN')
$$;
REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO fundchain_app;
GRANT EXECUTE ON FUNCTION app_is_admin() TO fundchain_app;

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;

-- 1. Siapa pun (login atau tidak) membaca campaign publik.
DROP POLICY IF EXISTS "campaigns_select_public" ON "campaigns";
CREATE POLICY "campaigns_select_public" ON "campaigns"
  FOR SELECT TO fundchain_app
  USING ("status" IN ('ACTIVE', 'FROZEN', 'COMPLETED'));

-- Pembuat selalu bisa melihat campaign miliknya (termasuk DRAFT / PENDING_REVIEW / REJECTED).
DROP POLICY IF EXISTS "campaigns_select_own" ON "campaigns";
CREATE POLICY "campaigns_select_own" ON "campaigns"
  FOR SELECT TO fundchain_app
  USING ("creator_id" = app_current_user_id());

-- 2. Pembuat hanya bisa mengubah campaign miliknya, dan hanya saat DRAFT / REJECTED.
--    WITH CHECK mencegah memindahkan kepemilikan ke user lain.
DROP POLICY IF EXISTS "campaigns_update_own" ON "campaigns";
CREATE POLICY "campaigns_update_own" ON "campaigns"
  FOR UPDATE TO fundchain_app
  USING ("creator_id" = app_current_user_id() AND "status" IN ('DRAFT', 'REJECTED'))
  WITH CHECK ("creator_id" = app_current_user_id() AND "status" IN ('DRAFT', 'REJECTED', 'PENDING_REVIEW'));

-- 3. Admin membaca semua campaign (dan mengubahnya untuk review / freeze / unfreeze).
DROP POLICY IF EXISTS "campaigns_select_admin" ON "campaigns";
CREATE POLICY "campaigns_select_admin" ON "campaigns"
  FOR SELECT TO fundchain_app
  USING (app_is_admin());

DROP POLICY IF EXISTS "campaigns_update_admin" ON "campaigns";
CREATE POLICY "campaigns_update_admin" ON "campaigns"
  FOR UPDATE TO fundchain_app
  USING (app_is_admin())
  WITH CHECK (app_is_admin());
