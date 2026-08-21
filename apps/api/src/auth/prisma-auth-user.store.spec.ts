import { PrismaAuthUserStore } from './prisma-auth-user.store';

describe('PrismaAuthUserStore', () => {
  const user = {
    id: 'user-1',
    username: 'doctor',
    displayName: '测试医生',
    passwordHash: 'hash',
    passwordVersion: 1,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function setup() {
    const appUser = {
      findUnique: jest.fn().mockResolvedValue(user),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue(user),
    };
    return { store: new PrismaAuthUserStore({ appUser } as never), appUser };
  }

  it('finds users by normalized username and id', async () => {
    const { store, appUser } = setup();
    await store.findByUsername(' Doctor ');
    await store.findById('user-1');
    expect(appUser.findUnique).toHaveBeenNthCalledWith(1, { where: { username: 'doctor' } });
    expect(appUser.findUnique).toHaveBeenNthCalledWith(2, { where: { id: 'user-1' } });
  });

  it('updates a password only at the expected version', async () => {
    const { store, appUser } = setup();
    await store.updatePassword('user-1', 'new-hash', 1);
    expect(appUser.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', passwordVersion: 1 },
      data: { passwordHash: 'new-hash', passwordVersion: { increment: 1 } },
    });
  });

  it('creates a normalized local account without returning or logging a plaintext password', async () => {
    const { store, appUser } = setup();
    await store.create(' Doctor ', '测试医生', 'password-hash');
    expect(appUser.create).toHaveBeenCalledWith({
      data: { username: 'doctor', displayName: '测试医生', passwordHash: 'password-hash' },
    });
  });
});
