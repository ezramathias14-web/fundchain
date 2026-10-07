/**
 * Pemeriksaan keamanan database (RLS & audit log) — dijalankan dari CI terjadwal
 * dan bisa dijalankan manual:  pnpm --filter @fundchain/api security:check
 *
 * Butuh DIRECT_URL (atau DATABASE_URL). Opsional: SUPABASE_URL + SUPABASE_ANON_KEY
 * untuk uji langsung lewat Data API (PostgREST) seperti yang dilakukan penyerang.
 *
 * Exit code 1 bila ada temuan, sehingga job CI berwarna merah.
 */
import { PrismaClient } from '@prisma/client';

const EXPOSED_ROLES = ['anon', 'authenticated'];
const PROBE_TABLES = ['users', 'donations', 'payments', 'audit_logs', 'stored_files'];
/** Policy campaigns yang wajib ada (migration 20261006010000_rls_campaign_policies). */
const REQUIRED_CAMPAIGN_POLICIES = [
  'campaigns_select_public',
  'campaigns_select_own',
  'campaigns_update_own',
  'campaigns_select_admin',
  'campaigns_update_admin',
];

interface Finding {
  check: string;
  detail: string;
}

async function main() {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL / DATABASE_URL belum diisi.');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const findings: Finding[] = [];
  const ok: string[] = [];

  try {
    // 1. Semua tabel di schema public wajib RLS aktif.
    const tables = await prisma.$queryRawUnsafe<{ tablename: string; rowsecurity: boolean }[]>(
      `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const noRls = tables.filter((t) => !t.rowsecurity).map((t) => t.tablename);
    if (noRls.length) findings.push({ check: 'RLS aktif', detail: `RLS mati di: ${noRls.join(', ')}` });
    else ok.push(`RLS aktif di ${tables.length} tabel public`);

    // 2. Tidak boleh ada policy yang membuka akses ke anon/authenticated/public.
    const policies = await prisma.$queryRawUnsafe<{ tablename: string; policyname: string; roles: string[] }[]>(
      `SELECT tablename, policyname, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public'`,
    );
    const openPolicies = policies.filter((p) => p.roles.some((r) => [...EXPOSED_ROLES, 'public'].includes(r)));
    if (openPolicies.length) {
      findings.push({
        check: 'Policy RLS',
        detail: openPolicies.map((p) => `${p.tablename}.${p.policyname} → ${p.roles.join('/')}`).join('; '),
      });
    } else ok.push(`Tidak ada policy yang membuka akses ke ${EXPOSED_ROLES.join('/')}`);

    // 2b. Policy campaigns (publik / pemilik / admin) lengkap dan hanya untuk role aplikasi.
    const campaignPolicies = policies.filter((p) => p.tablename === 'campaigns');
    const missingPolicies = REQUIRED_CAMPAIGN_POLICIES.filter((n) => !campaignPolicies.some((p) => p.policyname === n));
    const strayRoles = campaignPolicies.filter((p) => p.roles.some((r) => r !== 'fundchain_app'));
    if (missingPolicies.length) findings.push({ check: 'Policy campaigns', detail: `hilang: ${missingPolicies.join(', ')}` });
    else if (strayRoles.length) {
      findings.push({ check: 'Policy campaigns', detail: `berlaku untuk role selain fundchain_app: ${strayRoles.map((p) => p.policyname).join(', ')}` });
    } else ok.push(`Policy campaigns lengkap (${REQUIRED_CAMPAIGN_POLICIES.length}) untuk role fundchain_app`);

    // 3. Role Data API tidak punya hak tabel sama sekali (defense in depth).
    for (const role of EXPOSED_ROLES) {
      const exists = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`,
        role,
      );
      if (!exists[0]?.n) continue;
      const grants = await prisma.$queryRawUnsafe<{ table_name: string; privilege_type: string }[]>(
        `SELECT table_name, privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND grantee = $1`,
        role,
      );
      if (grants.length) {
        const list = [...new Set(grants.map((g) => g.table_name))];
        findings.push({ check: `Hak ${role}`, detail: `masih punya hak di: ${list.join(', ')}` });
      } else ok.push(`Role ${role} tidak punya hak tabel`);
    }

    // 4. Audit log append-only.
    const triggers = await prisma.$queryRawUnsafe<{ tgname: string }[]>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = '"audit_logs"'::regclass AND NOT tgisinternal`,
    );
    const names = triggers.map((t) => t.tgname);
    const missing = ['audit_logs_no_update_delete', 'audit_logs_no_truncate'].filter((n) => !names.includes(n));
    if (missing.length) findings.push({ check: 'Audit log append-only', detail: `trigger hilang: ${missing.join(', ')}` });
    else ok.push('Audit log append-only (trigger UPDATE/DELETE/TRUNCATE aktif)');
  } finally {
    await prisma.$disconnect();
  }

  // 5. Uji dari luar: Data API Supabase dengan anon key harus tidak mengembalikan data.
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (supabaseUrl && anonKey) {
    for (const table of PROBE_TABLES) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&limit=1`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      });
      const body = await res.text();
      const leaked = res.ok && body.trim() !== '[]';
      if (leaked) findings.push({ check: 'Data API anon', detail: `${table} bocor (HTTP ${res.status})` });
      else ok.push(`Data API anon → ${table}: tertutup (HTTP ${res.status})`);
    }
  } else {
    ok.push('Uji Data API dilewati (SUPABASE_URL / SUPABASE_ANON_KEY tidak diisi)');
  }

  for (const line of ok) console.log(`✓ ${line}`);
  for (const f of findings) console.error(`✗ ${f.check}: ${f.detail}`);
  if (findings.length) {
    console.error(`\n${findings.length} temuan keamanan.`);
    process.exit(1);
  }
  console.log('\nSemua pemeriksaan keamanan database lolos.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
