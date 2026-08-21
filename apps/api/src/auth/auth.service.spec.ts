import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const activeUser = {
    id: 'user-1',
    username: 'doctor',
    displayName: '测试医生',
    passwordHash: 'stored-hash',
    passwordVersion: 1,
    isActive: true,
  };

  function setup(user: typeof activeUser | null = activeUser) {
    const users = {
      findByUsername: jest.fn().mockResolvedValue(user),
      findById: jest.fn().mockResolvedValue(user),
      updatePassword: jest.fn().mockResolvedValue({ ...activeUser, passwordVersion: 2 }),
      create: jest.fn(),
    };
    const passwords = {
      verify: jest
        .fn()
        .mockImplementation(
          async (_hash: string, password: string) => password === 'correct-password',
        ),
      hash: jest.fn().mockResolvedValue('new-hash'),
    };
    const tokens = { sign: jest.fn().mockReturnValue('signed-token'), verify: jest.fn() };
    return { service: new AuthService(users, passwords, tokens), users, passwords, tokens };
  }

  it('returns minimum user data and a signed token for valid credentials', async () => {
    const { service, tokens } = setup();

    await expect(service.login('doctor', 'correct-password')).resolves.toEqual({
      user: { id: 'user-1', username: 'doctor', displayName: '测试医生' },
      token: 'signed-token',
    });
    expect(tokens.sign).toHaveBeenCalledWith({
      sub: 'user-1',
      username: 'doctor',
      passwordVersion: 1,
    });
  });

  it.each([null, activeUser])(
    'uses the same unauthorized result for an unknown account or wrong password',
    async (user) => {
      const { service, passwords } = setup(user);
      passwords.verify.mockResolvedValue(false);

      await expect(service.login('doctor', 'wrong-password')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('rejects a disabled account', async () => {
    const { service } = setup({ ...activeUser, isActive: false });
    await expect(service.login('doctor', 'correct-password')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('changes a password, increments its version and does not return secrets', async () => {
    const { service, users, passwords } = setup();

    await expect(
      service.changePassword('user-1', 'correct-password', 'new-password', 'new-password'),
    ).resolves.toBeUndefined();
    expect(passwords.hash).toHaveBeenCalledWith('new-password');
    expect(users.updatePassword).toHaveBeenCalledWith('user-1', 'new-hash', 1);
  });

  it('rejects an incorrect current password and a reused password', async () => {
    const incorrect = setup();
    incorrect.passwords.verify.mockResolvedValueOnce(false);
    await expect(
      incorrect.service.changePassword('user-1', 'wrong-password', 'new-password', 'new-password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const reused = setup();
    await expect(
      reused.service.changePassword(
        'user-1',
        'correct-password',
        'correct-password',
        'correct-password',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('invalidates a token when the account is absent, disabled or its password version changed', async () => {
    const missing = setup(null);
    await expect(
      missing.service.validateSession({ sub: 'user-1', username: 'doctor', passwordVersion: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const disabled = setup({ ...activeUser, isActive: false });
    await expect(
      disabled.service.validateSession({ sub: 'user-1', username: 'doctor', passwordVersion: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const changed = setup({ ...activeUser, passwordVersion: 2 });
    await expect(
      changed.service.validateSession({ sub: 'user-1', username: 'doctor', passwordVersion: 1 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
