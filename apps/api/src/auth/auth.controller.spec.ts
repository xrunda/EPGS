import { AuthController } from './auth.controller';

describe('AuthController', () => {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: false,
    path: '/',
    maxAge: 28_800_000,
  } as const;

  function setup() {
    const auth = {
      login: jest.fn().mockResolvedValue({
        user: { id: 'user-1', username: 'doctor', displayName: '测试医生' },
        token: 'signed-token',
      }),
      changePassword: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AuthController(auth, cookieOptions);
    const response = { cookie: jest.fn(), clearCookie: jest.fn() };
    return { controller, auth, response };
  }

  it('sets a HttpOnly cookie and never returns the JWT after login', async () => {
    const { controller, response } = setup();
    const result = await controller.login(
      { username: 'doctor', password: 'password-1' },
      response as never,
    );

    expect(response.cookie).toHaveBeenCalledWith('epgs_session', 'signed-token', cookieOptions);
    expect(result).toEqual({ user: { id: 'user-1', username: 'doctor', displayName: '测试医生' } });
    expect(JSON.stringify(result)).not.toContain('signed-token');
  });

  describe('GET /api/auth/me (issue #139 patientDetail)', () => {
    const sessionUser = { id: 'user-1', username: 'doctor', displayName: '测试医生' };

    it('echoes the roles and the patientDetail grant resolved by RolesGuard', () => {
      const { controller } = setup();
      const result = controller.me({
        user: sessionUser,
        accessUser: {
          username: 'doctor',
          roles: ['VIEWER'],
          departmentScope: ['消化内科'],
          patientDetail: true,
        },
      } as never);

      expect(result).toEqual({
        user: { ...sessionUser, roles: ['VIEWER'], patientDetail: true },
      });
    });

    it('fails closed to patientDetail:false when the account has no access row', () => {
      const { controller } = setup();

      expect(controller.me({ user: sessionUser } as never)).toEqual({
        user: { ...sessionUser, roles: [], patientDetail: false },
      });
      expect(
        controller.me({ user: sessionUser, accessUser: null } as never).user.patientDetail,
      ).toBe(false);
    });

    it('never leaks the access grant itself (scope stays server-side)', () => {
      const { controller } = setup();
      const result = controller.me({
        user: sessionUser,
        accessUser: {
          username: 'doctor',
          roles: ['VIEWER'],
          departmentScope: ['消化内科'],
          patientDetail: false,
        },
      } as never);

      // departmentScope is a server-side filter, not a UI input - the workbench
      // never sends it, so it must not ride along on /me.
      expect(JSON.stringify(result)).not.toContain('消化内科');
      expect(result.user).not.toHaveProperty('departmentScope');
    });
  });

  it('clears the cookie on logout and after a password change', async () => {
    const { controller, response } = setup();
    controller.logout(response as never);
    expect(response.clearCookie).toHaveBeenCalledWith(
      'epgs_session',
      expect.objectContaining({ httpOnly: true, path: '/' }),
    );

    await controller.changePassword(
      { user: { id: 'user-1', username: 'doctor', displayName: '测试医生' } } as never,
      { currentPassword: 'password-1', newPassword: 'password-2', confirmPassword: 'password-2' },
      response as never,
    );
    expect(response.clearCookie).toHaveBeenCalledTimes(2);
  });
});
