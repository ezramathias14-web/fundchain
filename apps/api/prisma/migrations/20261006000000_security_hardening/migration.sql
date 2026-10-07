-- Security hardening (infra & security)
--
-- 1. Audit log append-only: UPDATE/DELETE/TRUNCATE pada audit_logs ditolak database,
--    termasuk oleh role postgres/owner yang dipakai backend. Orang dalam yang mengedit
--    lewat SQL editor pun tidak bisa menghapus jejak tanpa DROP TRIGGER (DDL yang kelihatan).
--    Satu-satunya UPDATE yang diizinkan: actor_id → NULL akibat FK ON DELETE SET NULL
--    saat user dihapus.
-- 2. Defense in depth untuk RLS: cabut semua hak tabel dari role anon & authenticated
--    (Supabase Data API). RLS tanpa policy sudah menutup akses; REVOKE menutupnya dua kali.
--    Blok dilewati otomatis di Postgres lokal yang tidak punya role tersebut.

CREATE OR REPLACE FUNCTION "audit_logs_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."actor_id" IS NOT NULL AND NEW."actor_id" IS NULL
     AND NEW."id" = OLD."id" AND NEW."action" = OLD."action"
     AND NEW."entity_type" = OLD."entity_type" AND NEW."entity_id" IS NOT DISTINCT FROM OLD."entity_id"
     AND NEW."metadata" = OLD."metadata" AND NEW."ip_address" IS NOT DISTINCT FROM OLD."ip_address"
     AND NEW."created_at" = OLD."created_at" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs bersifat append-only (% ditolak)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS "audit_logs_no_update_delete" ON "audit_logs";
CREATE TRIGGER "audit_logs_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_append_only"();

DROP TRIGGER IF EXISTS "audit_logs_no_truncate" ON "audit_logs";
CREATE TRIGGER "audit_logs_no_truncate"
  BEFORE TRUNCATE ON "audit_logs"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_logs_append_only"();

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      -- Tabel/sequence baru yang dibuat migration berikutnya juga tidak otomatis terekspos.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END;
$$;
