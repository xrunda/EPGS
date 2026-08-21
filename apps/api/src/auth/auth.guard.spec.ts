import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';

describe('AuthGuard', () => {
  function context(cookie?: string): {
    context: ExecutionContext;
    request: Record<string, unknown>;
  } {
    const request = { headers: cookie ? { cookie } : {} };
    return {
      request,
      context: {
        getHandler: () => function handler() {},
        getClass: () => class Controller {},
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext,
    };
  }

  it('allows explicitly public endpoints without a cookie', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(true),
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector, { verify: jest.fn() }, { validateSession: jest.fn() });
    await expect(guard.canActivate(context().context)).resolves.toBe(true);
  });

  it('rejects requests without the session cookie', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector, { verify: jest.fn() }, { validateSession: jest.fn() });
    await expect(guard.canActivate(context().context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('validates the JWT payload and attaches only minimum user data to the request', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const tokens = {
      verify: jest.fn().mockReturnValue({ sub: 'user-1', username: 'doctor', passwordVersion: 1 }),
    };
    const auth = {
      validateSession: jest
        .fn()
        .mockResolvedValue({ id: 'user-1', username: 'doctor', displayName: '测试医生' }),
    };
    const guard = new AuthGuard(reflector, tokens, auth);
    const testContext = context('other=value; epgs_session=signed.jwt; theme=dark');

    await expect(guard.canActivate(testContext.context)).resolves.toBe(true);
    expect(tokens.verify).toHaveBeenCalledWith('signed.jwt');
    expect(testContext.request.user).toEqual({
      id: 'user-1',
      username: 'doctor',
      displayName: '测试医生',
    });
  });

  it('returns a generic unauthorized error for malformed or expired JWTs', async () => {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(false),
    } as unknown as Reflector;
    const guard = new AuthGuard(
      reflector,
      {
        verify: jest.fn().mockImplementation(() => {
          throw new Error('secret token detail');
        }),
      },
      { validateSession: jest.fn() },
    );

    await expect(guard.canActivate(context('epgs_session=bad').context)).rejects.toMatchObject({
      response: { code: 'AUTH_REQUIRED' },
    });
  });
});
