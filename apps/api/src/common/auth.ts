import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@fundchain/shared';
import type { Request } from 'express';
import { AppError } from './app-error';
import { AuditService } from '../modules/audit/audit.service';
import { PrismaService } from './prisma.service';
import { verifySessionToken } from './session-token';

/**
 * Login Google (popup). Setelah login, API menerbitkan token sesi yang dikirim frontend
 * lewat header `Authorization: Bearer <token>`.
 * Role SELALU dibaca dari database, tidak pernah dari request (BR-AUTH-002).
 */
export interface CurrentUserPayload {
  id: string;
  email: string;
  name: string;
  role: Role;
  integritySubjectId: string;
}

export type AuthedRequest = Request & { user?: CurrentUserPayload };

const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';

/** Endpoint boleh diakses tanpa identitas (user tetap di-attach kalau header ada). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().ip ?? null;
});

@Injectable()
export class ActingUserGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    req.user = await this.resolveUser(req);

    const targets = [ctx.getHandler(), ctx.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets);

    if (isPublic && !roles) return true;
    if (!req.user) throw new AppError('AUTH_UNAUTHENTICATED', 'Silakan login dengan Google terlebih dahulu.');
    if (roles?.length && !roles.includes(req.user.role)) {
      // User yang sudah login mencoba endpoint admin → catat (indikasi privilege escalation).
      if (roles.includes('ADMIN')) {
        await this.audit
          .log({
            actorId: req.user.id,
            action: 'ADMIN_ACCESS_DENIED',
            entityType: 'AdminAction',
            entityId: null,
            metadata: { method: req.method, route: req.originalUrl?.split('?')[0] ?? req.url, role: req.user.role },
            ipAddress: req.ip ?? null,
          })
          .catch(() => undefined);
      }
      throw new AppError('AUTH_FORBIDDEN', 'Anda tidak memiliki akses ke fitur ini.');
    }
    return true;
  }

  private async resolveUser(req: Request): Promise<CurrentUserPayload | undefined> {
    const match = /^Bearer (.+)$/.exec(req.header('authorization') ?? '');
    if (!match || match[1].length > 512) return undefined;
    const userId = verifySessionToken(match[1]);
    if (!userId) return undefined;
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) return undefined;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as Role,
      integritySubjectId: user.integritySubjectId,
    };
  }
}
