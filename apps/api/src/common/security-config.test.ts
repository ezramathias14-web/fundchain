import { describe, expect, it } from 'vitest';
import { checkSecurityConfig, enforceSecurityConfig } from './security-config';

const strong = 'x'.repeat(40);
const goodProd: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  SESSION_SECRET: strong,
  FILE_URL_SECRET: 'y'.repeat(40),
  CRON_SECRET: 'z'.repeat(40),
  WORKER_MODE: 'on-demand',
  PAYMENT_PROVIDER: 'pakasir',
  PAKASIR_API_KEY: 'k',
  PAKASIR_PROJECT: 'p',
  ENABLE_DEV_TOOLS: 'false',
  BLOCKCHAIN_NETWORK: 'sepolia',
  RELAYER_PRIVATE_KEY: '0x' + '1'.repeat(64),
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  ADMIN_EMAILS: 'admin@binus.ac.id',
  WEB_URL: 'https://fundchain-web.vercel.app',
};
const keys = (env: NodeJS.ProcessEnv) => checkSecurityConfig(env).map((i) => `${i.severity}:${i.key}`);

describe('security config check', () => {
  it('tidak memeriksa apa pun di luar production', () => {
    expect(checkSecurityConfig({ NODE_ENV: 'development' })).toEqual([]);
  });

  it('konfigurasi production yang benar bersih', () => {
    expect(checkSecurityConfig(goodProd)).toEqual([]);
  });

  it('menandai secret kosong/lemah dan secret yang sama', () => {
    const k = keys({ ...goodProd, SESSION_SECRET: 'short', FILE_URL_SECRET: 'short' });
    expect(k).toContain('error:SESSION_SECRET');
    expect(k).toContain('error:FILE_URL_SECRET');
    expect(keys({ ...goodProd, FILE_URL_SECRET: strong })).toContain('error:FILE_URL_SECRET');
  });

  it('menolak webhook secret mock bawaan dan kunci Hardhat publik', () => {
    const k = keys({
      ...goodProd,
      PAYMENT_PROVIDER: 'mock',
      MOCK_WEBHOOK_SECRET: 'dev-mock-webhook-secret',
      RELAYER_PRIVATE_KEY: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
    });
    expect(k).toContain('error:MOCK_WEBHOOK_SECRET');
    expect(k).toContain('error:RELAYER_PRIVATE_KEY');
  });

  it('dev tools aktif hanya warning', () => {
    expect(keys({ ...goodProd, ENABLE_DEV_TOOLS: undefined })).toEqual(['warn:ENABLE_DEV_TOOLS']);
  });

  it('SECURITY_STRICT menggagalkan start bila ada error', () => {
    const bad = { ...goodProd, SESSION_SECRET: '' };
    expect(() => enforceSecurityConfig(bad)).not.toThrow();
    expect(() => enforceSecurityConfig({ ...bad, SECURITY_STRICT: 'true' })).toThrow(/SESSION_SECRET/);
  });
});
