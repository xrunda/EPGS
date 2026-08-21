import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppRole } from '@prisma/client';
import { SessionUser } from '../auth/auth.types';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { AccessResolver } from './access-resolver';
import { AccessUser } from './access-user';
import { ROLES_KEY } from './access.decorators';

type GuardRequest = Request & { user?: SessionUser; accessUser?: AccessUser | null };

/**
 * Global authorization guard (issue #13), registered AFTER issue #31's
 * AuthGuard so `request.user` is already populated for non-public routes.
 *
 * Behavior:
 * - @Public routes: pass through untouched (matching AuthGuard).
 * - Any authenticated user passes routes with NO @RequireRoles metadata.
 * - A route with @RequireRoles(...) requires the caller's access grant to
 *   include at least one listed role; otherwise 403 FORBIDDEN.
 * - An authenticated account with no app_user_access row has no roles and
 *   therefore fails every role-gated route (fail-closed).
 *
 * Also attaches `request.accessUser` for downstream controllers to read via
 * @CurrentUser().
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: AccessResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<GuardRequest>();
    // AuthGuard always sets request.user on non-public routes; this is a
    // defensive check in case the guard ordering ever changes.
    if (!request.user) {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED', message: '请先登录。' });
    }

    request.accessUser = await this.access.resolveByUsername(request.user.username);

    const required = this.reflector.getAllAndOverride<AppRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const roles = request.accessUser?.roles ?? [];
    const granted = required.some((role) => roles.includes(role));
    if (!granted) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: '没有权限访问该资源。' });
    }
    return true;
  }
}
