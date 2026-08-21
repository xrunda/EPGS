import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppRole } from '@prisma/client';
import { AccessUser } from './access-user';
import { AccessResolver } from './access-resolver';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from './access.decorators';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';

describe('RolesGuard (issue #13)', () => {
  const grant: AccessUser = {
    username: 'doctor',
    roles: [AppRole.RULE_ADMIN],
    departmentScope: [],
    patientDetail: false,
  };

  function makeGuard(accessUser: AccessUser | null = grant) {
    const access = {
      resolveByUsername: jest.fn().mockResolvedValue(accessUser),
    } as unknown as AccessResolver;
    const guard = new RolesGuard(new Reflector(), access);
    return { guard, access };
  }

  function makeContext({
    user,
    handler,
    cls,
  }: {
    user?: { username: string };
    handler: { name: string };
    cls: { name: string };
  }): {
    context: ExecutionContext;
    request: { user?: { username: string }; accessUser?: AccessUser | null };
  } {
    const request: { user?: { username: string }; accessUser?: AccessUser | null } = { user };
    const context = {
      getHandler: () => handler,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  function handlerWith(roles?: AppRole[]): { name: string } {
    const handler = { name: 'handler' };
    if (roles) Reflect.defineMetadata(ROLES_KEY, roles, handler);
    return handler;
  }

  function clsWith(roles?: AppRole[]): { name: string } {
    const cls = { name: 'class' };
    if (roles) Reflect.defineMetadata(ROLES_KEY, roles, cls);
    return cls;
  }

  it('lets @Public routes through without resolving the access grant', async () => {
    const { guard, access } = makeGuard();
    const handler = { name: 'handler' };
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const { context } = makeContext({ handler, cls: { name: 'class' } });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(access.resolveByUsername).not.toHaveBeenCalled();
  });

  it('throws 401 when request.user is missing on a non-public route (defensive)', async () => {
    const { guard, access } = makeGuard();
    const { context } = makeContext({
      handler: handlerWith([AppRole.VIEWER]),
      cls: { name: 'class' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(access.resolveByUsername).not.toHaveBeenCalled();
  });

  it('passes an authenticated user through a route with no role metadata and attaches accessUser', async () => {
    const { guard, access } = makeGuard();
    const { context, request } = makeContext({
      user: { username: 'doctor' },
      handler: { name: 'handler' },
      cls: { name: 'class' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(access.resolveByUsername).toHaveBeenCalledWith('doctor');
    expect(request.accessUser).toEqual(grant);
  });

  it('passes when the user holds at least one required role', async () => {
    const { guard } = makeGuard();
    const { context } = makeContext({
      user: { username: 'doctor' },
      handler: handlerWith([AppRole.RULE_ADMIN]),
      cls: { name: 'class' },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('throws 403 when the user holds none of the required roles', async () => {
    const { guard } = makeGuard();
    const { context } = makeContext({
      user: { username: 'doctor' },
      handler: handlerWith([AppRole.VIEWER, AppRole.AUDITOR]),
      cls: { name: 'class' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a method-level @RequireRoles override a class-level one', async () => {
    const { guard } = makeGuard();
    // Class requires VIEWER; the handler overrides with RULE_ADMIN, which the
    // caller holds - so the request passes even though VIEWER is not held.
    const handler = handlerWith([AppRole.RULE_ADMIN]);
    const cls = clsWith([AppRole.VIEWER]);
    const { context } = makeContext({ user: { username: 'doctor' }, handler, cls });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('fails closed (403) for an authenticated account with no access row', async () => {
    const { guard } = makeGuard(null);
    const { context } = makeContext({
      user: { username: 'nobody' },
      handler: handlerWith([AppRole.VIEWER]),
      cls: { name: 'class' },
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
