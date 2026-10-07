import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { env } from './common/env';
import { validationExceptionFactory } from './common/http';
import { enforceSecurityConfig } from './common/security-config';

/** Konfigurasi bersama untuk server lokal (main.ts) dan Vercel Function (serverless.ts). */
export function configureApp(app: INestApplication) {
  // Production: log (atau tolak, bila SECURITY_STRICT=true) secret yang kosong/lemah.
  enforceSecurityConfig();
  const cfg = env();
  app.setGlobalPrefix('api/v1');
  (app as NestExpressApplication).set('trust proxy', cfg.isProduction ? 1 : 'loopback');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.enableCors({
    origin: cfg.webUrl.split(','),
    credentials: true,
    allowedHeaders: ['Content-Type', 'Idempotency-Key', 'Authorization'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
}
