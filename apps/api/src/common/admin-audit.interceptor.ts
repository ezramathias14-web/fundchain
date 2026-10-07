import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@fundchain/shared';
import { catchError, Observable, throwError } from 'rxjs';
import { AuditService } from '../modules/audit/audit.service';
import { AppError } from './app-error';
import { type AuthedRequest, ROLES_KEY } from './auth';

/**
 * Catat aksi admin yang GAGAL (ditolak validasi, status tidak sah, error RPC, dll.).
 *
 * Aksi admin yang berhasil sudah dicatat oleh service masing-masing dengan event domain
 * (CAMPAIGN_APPROVED, DISBURSEMENT_APPROVED, INTEGRITY_VERIFIED, ...). Interceptor ini
 * menutup sisanya: setiap percobaan aksi admin (POST/PATCH/PUT/DELETE) yang gagal
 * tetap meninggalkan jejak `ADMIN_ACTION_FAILED`, sehingga upaya yang mencurigakan
 * (mis. mencoba mencairkan dana campaign FROZEN berulang kali) terlihat di audit log.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AdminAudit');

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    const isAdminMutation = !!roles?.includes('ADMIN') && req.method !== 'GET' && req.method !== 'HEAD';
    if (!isAdminMutation) return next.handle();

    return next.handle().pipe(
      catchError((err: unknown) => {
        const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
        this.audit
          .log({
            actorId: req.user?.id ?? null,
            action: 'ADMIN_ACTION_FAILED',
            entityType: 'AdminAction',
            entityId: firstParam(req.params),
            metadata: {
              method: req.method,
              route: routeOf(req),
              params: req.params,
              errorCode: code,
              message: err instanceof Error ? err.message.slice(0, 300) : String(err),
            },
            ipAddress: req.ip ?? null,
          })
          .catch((e: unknown) => this.logger.error(`Gagal mencatat audit: ${(e as Error).message}`));
        return throwError(() => err);
      }),
    );
  }
}

export function routeOf(req: AuthedRequest): string {
  const path = (req.route as { path?: string } | undefined)?.path;
  return path ?? req.originalUrl?.split('?')[0] ?? req.url;
}

function firstParam(params: Record<string, string | string[]> | undefined): string | null {
  const first = Object.values(params ?? {})[0];
  if (first === undefined) return null;
  return Array.isArray(first) ? first.join('/') : first;
}
