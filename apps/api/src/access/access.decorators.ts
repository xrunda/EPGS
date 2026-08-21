import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { AccessUser } from './access-user';

/**
 * Metadata key for the roles required by a route (issue #13). Enforced by
 * RolesGuard via `Reflector.getAllAndOverride([handler, class])`, so a
 * method-level @RequireRoles overrides any class-level one. A route with no
 * @RequireRoles metadata is open to any authenticated user.
 */
export const ROLES_KEY = 'epgs:requiredRoles';

/** Requires the caller to hold at least one of the listed roles. */
export const RequireRoles = (...roles: AppRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Injects the current request's AccessUser (issue #13), or null when the
 * route is public / the account has no access row. Values: `@CurrentUser()`
 * inside a controller method parameter.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessUser | null => {
    const request = context.switchToHttp().getRequest<{ accessUser?: AccessUser }>();
    return request.accessUser ?? null;
  },
);
