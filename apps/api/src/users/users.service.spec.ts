import { ConflictException } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserConflictException } from './errors/user-conflict.exception';
import { UserNotFoundException } from './errors/user-not-found.exception';

/**
 * Unit tests against a mocked PrismaService and a fake PasswordHasher - no
 * real database. Covers the business logic (uniqueness check, orphan access
 * cleanup on delete, departmentScope preservation, last-USER_ADMIN lockout
 * guard) in isolation; apps/api/test/users.e2e-spec.ts covers the same
 * scenarios end-to-end against a real Postgres (RolesGuard, audit rows,
 * actual login behavior).
 */
describe('UsersService', () => {
  let prisma: any;
  let hasher: any;
  let service: UsersService;
  let users: Map<string, any>;
  let access: Map<string, any>;

  function makeUser(overrides: Partial<any> = {}): any {
    const id = overrides.id ?? `user-${Math.random().toString(36).slice(2)}`;
    const user = {
      id,
      username: 'doctor',
      displayName: '李医生',
      passwordHash: 'hashed:old',
      passwordVersion: 1,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
    users.set(id, user);
    return user;
  }

  beforeEach(() => {
    users = new Map();
    access = new Map();

    const appUser = {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return users.get(where.id) ?? null;
        if (where.username) {
          return Array.from(users.values()).find((u) => u.username === where.username) ?? null;
        }
        return null;
      }),
      findMany: jest.fn(async ({ where, skip = 0, take }: any) => {
        let candidates = Array.from(users.values());
        if (where?.isActive !== undefined) {
          candidates = candidates.filter((u) => u.isActive === where.isActive);
        }
        if (where?.OR) {
          const search = where.OR[0].username.contains.toLowerCase();
          candidates = candidates.filter(
            (u) =>
              u.username.toLowerCase().includes(search) ||
              u.displayName.toLowerCase().includes(search),
          );
        }
        return candidates.slice(skip, take ? skip + take : undefined);
      }),
      count: jest.fn(async () => users.size),
      create: jest.fn(async ({ data }: any) => makeUser(data)),
      update: jest.fn(async ({ where, data }: any) => {
        const user = users.get(where.id);
        if (data.passwordVersion?.increment) {
          data = { ...data, passwordVersion: user.passwordVersion + data.passwordVersion.increment };
        }
        const updated = { ...user, ...data };
        users.set(where.id, updated);
        return updated;
      }),
      delete: jest.fn(async ({ where }: any) => {
        users.delete(where.id);
        return null;
      }),
    };

    const appUserAccess = {
      findUnique: jest.fn(async ({ where }: any) => access.get(where.username) ?? null),
      deleteMany: jest.fn(async ({ where }: any) => {
        access.delete(where.username);
        return { count: 1 };
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const usernames: string[] = where?.username?.in ?? [];
        return Array.from(access.values()).filter((a) => usernames.includes(a.username));
      }),
      count: jest.fn(async ({ where }: any) => {
        return Array.from(access.values()).filter((a) => {
          if (where?.username?.not !== undefined && a.username === where.username.not) return false;
          if (where?.roles?.has !== undefined && !a.roles.includes(where.roles.has)) return false;
          return true;
        }).length;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = access.get(where.username);
        const saved = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { ...create, updatedAt: new Date() };
        access.set(where.username, saved);
        return saved;
      }),
    };

    prisma = {
      appUser,
      appUserAccess,
      $transaction: jest.fn(async (ops: any) => {
        if (Array.isArray(ops)) return Promise.all(ops);
        return ops(prisma);
      }),
    };

    hasher = {
      hash: jest.fn(async (password: string) => `hashed:${password}`),
      verify: jest.fn(async () => true),
    };

    service = new UsersService(prisma, hasher);
  });

  describe('create', () => {
    it('creates an account with no access grant (roles: null in the DTO)', async () => {
      const result = await service.create({
        username: 'Doctor',
        displayName: ' 李医生 ',
        password: 'password123',
        confirmPassword: 'password123',
      } as any);

      expect(result.username).toBe('doctor'); // lowercased
      expect(result.roles).toBeNull();
      expect(hasher.hash).toHaveBeenCalledWith('password123');
      expect(prisma.appUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ username: 'doctor', displayName: '李医生' }),
        }),
      );
    });

    it('rejects a duplicate username', async () => {
      makeUser({ username: 'doctor' });
      await expect(
        service.create({
          username: 'doctor',
          displayName: '另一个人',
          password: 'password123',
          confirmPassword: 'password123',
        } as any),
      ).rejects.toBeInstanceOf(UserConflictException);
    });
  });

  describe('updateStatus', () => {
    it('toggles isActive and 404s for an unknown username', async () => {
      makeUser({ username: 'doctor', isActive: true });
      const disabled = await service.updateStatus('doctor', false);
      expect(disabled.isActive).toBe(false);

      await expect(service.updateStatus('ghost', false)).rejects.toBeInstanceOf(
        UserNotFoundException,
      );
    });
  });

  describe('resetPassword', () => {
    it('increments passwordVersion so existing sessions are invalidated', async () => {
      const user = makeUser({ username: 'doctor', passwordVersion: 3 });
      await service.resetPassword('doctor', 'newpassword123');
      expect(users.get(user.id).passwordVersion).toBe(4);
      expect(users.get(user.id).passwordHash).toBe('hashed:newpassword123');
    });
  });

  describe('delete', () => {
    it('deletes the account and its access grant together', async () => {
      const user = makeUser({ username: 'doctor' });
      access.set('doctor', { username: 'doctor', roles: ['VIEWER'], departmentScope: [], patientDetail: false });

      await service.delete('doctor');

      expect(users.has(user.id)).toBe(false);
      expect(access.has('doctor')).toBe(false);
    });

    it('404s for an unknown username without touching access rows', async () => {
      await expect(service.delete('ghost')).rejects.toBeInstanceOf(UserNotFoundException);
    });

    it('is case-insensitive on the username path param, like create()', async () => {
      const user = makeUser({ username: 'doctor' });
      await service.delete('Doctor');
      expect(users.has(user.id)).toBe(false);
    });
  });

  describe('last-USER_ADMIN lockout guard', () => {
    it('refuses to delete the sole USER_ADMIN account', async () => {
      makeUser({ username: 'admin' });
      access.set('admin', { username: 'admin', roles: ['USER_ADMIN'], departmentScope: [], patientDetail: false });

      await expect(service.delete('admin')).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows deleting a USER_ADMIN when another one remains', async () => {
      const target = makeUser({ username: 'admin1' });
      makeUser({ username: 'admin2' });
      access.set('admin1', { username: 'admin1', roles: ['USER_ADMIN'], departmentScope: [], patientDetail: false });
      access.set('admin2', { username: 'admin2', roles: ['USER_ADMIN'], departmentScope: [], patientDetail: false });

      await service.delete('admin1');
      expect(users.has(target.id)).toBe(false);
    });

    it('refuses to disable the sole USER_ADMIN account, but allows re-enabling', async () => {
      makeUser({ username: 'admin', isActive: true });
      access.set('admin', { username: 'admin', roles: ['USER_ADMIN'], departmentScope: [], patientDetail: false });

      await expect(service.updateStatus('admin', false)).rejects.toBeInstanceOf(ConflictException);
      // Enabling is never destructive, so it must not be guarded.
      await expect(service.updateStatus('admin', true)).resolves.toBeDefined();
    });

    it('refuses to strip USER_ADMIN from the sole account via updateAccess, but allows keeping it', async () => {
      makeUser({ username: 'admin' });
      access.set('admin', { username: 'admin', roles: ['USER_ADMIN'], departmentScope: [], patientDetail: false });

      await expect(
        service.updateAccess('admin', { roles: ['VIEWER'] as any, patientDetail: false }),
      ).rejects.toBeInstanceOf(ConflictException);

      const kept = await service.updateAccess('admin', {
        roles: ['USER_ADMIN', 'SYSTEM_ADMIN'] as any,
        patientDetail: false,
      });
      expect(kept.roles).toEqual(['USER_ADMIN', 'SYSTEM_ADMIN']);
    });

    it('does not block ordinary role edits on a non-USER_ADMIN account', async () => {
      makeUser({ username: 'doctor' });
      access.set('doctor', { username: 'doctor', roles: ['VIEWER'], departmentScope: [], patientDetail: false });
      await expect(service.delete('doctor')).resolves.toBeUndefined();
    });
  });

  describe('getAccess / updateAccess', () => {
    it('returns an empty-roles placeholder for an account with no grant yet', async () => {
      makeUser({ username: 'doctor' });
      const result = await service.getAccess('doctor');
      expect(result.roles).toEqual([]);
      expect(result.departmentScope).toEqual([]);
    });

    it('full-replaces roles/patientDetail and writes departmentScope: [] for a fresh grant', async () => {
      makeUser({ username: 'doctor' });

      const result = await service.updateAccess('doctor', {
        roles: ['SYSTEM_ADMIN'] as any,
        patientDetail: true,
      });

      expect(result.roles).toEqual(['SYSTEM_ADMIN']);
      expect(result.departmentScope).toEqual([]);
      expect(result.patientDetail).toBe(true);
    });

    it('preserves a pre-existing non-empty departmentScope instead of silently wiping it (issue #78 review fix)', async () => {
      makeUser({ username: 'doctor' });
      access.set('doctor', {
        username: 'doctor',
        roles: ['VIEWER'],
        departmentScope: ['消化内科', '呼吸内科'],
        patientDetail: false,
      });

      const result = await service.updateAccess('doctor', {
        roles: ['SYSTEM_ADMIN'] as any,
        patientDetail: true,
      });

      expect(result.roles).toEqual(['SYSTEM_ADMIN']);
      expect(result.departmentScope).toEqual(['消化内科', '呼吸内科']);
      expect(result.patientDetail).toBe(true);
    });
  });
});
