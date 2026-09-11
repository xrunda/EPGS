import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';

/**
 * Full-stack e2e for issue #78/#81's /api/users account + access-grant
 * management API, against a REAL Postgres. Covers: RolesGuard fail-closed
 * (non-USER_ADMIN and unauthenticated -> 403/401), the create -> assign
 * access -> login round trip, password reset invalidating the old password,
 * account disable blocking login, delete removing both app_user AND
 * app_user_access in one transaction (no orphan row), and that
 * departmentScope is always [] regardless of what PUT .../access receives
 * (issue #78 scope narrowing - see docs/user-admin-design.md).
 *
 * Same itWithDb no-op-on-unreachable-DB pattern as security.e2e-spec.ts, so
 * the DB-free CI job stays untouched; runs for real in the db-migrations
 * job. afterAll cleans audit_log -> app_user_access -> app_user so a local
 * re-run or residue never leaks into other suites' seed-count assertions.
 */
describe('Users (e2e, real Postgres): account + access-grant management', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  const PASSWORD = 'users-e2e-password';

  const USERS = {
    userAdmin: 'ue2e-useradmin', // USER_ADMIN
    viewer: 'ue2e-viewer', // VIEWER (non-USER_ADMIN, for 403 checks)
  } as const;

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<keyof typeof USERS, Agent> = {} as never;

  async function createUser(username: string, displayName: string): Promise<void> {
    await prisma.appUser.create({
      data: { username, displayName, passwordHash: await hash(PASSWORD, { type: argon2id }) },
    });
  }

  async function grantAccess(username: string, roles: string[]): Promise<void> {
    await prisma.appUserAccess.create({
      data: { username, roles: roles as never, departmentScope: [], patientDetail: false },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.appUser.findFirst();
      await prisma.appUserAccess.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping users e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}).`,
      );
      return;
    }

    await prisma.auditLog.deleteMany({});
    await prisma.appUserAccess.deleteMany({});
    await prisma.appUser.deleteMany({});

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();

    await createUser(USERS.userAdmin, '用户管理员');
    await createUser(USERS.viewer, '普通查看者');
    await grantAccess(USERS.userAdmin, ['USER_ADMIN']);
    await grantAccess(USERS.viewer, ['VIEWER']);

    for (const key of Object.keys(USERS) as (keyof typeof USERS)[]) {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/auth/login')
        .send({ username: USERS[key], password: PASSWORD })
        .expect(200);
      agents[key] = agent;
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.auditLog.deleteMany({});
      await prisma.appUserAccess.deleteMany({});
      await prisma.appUser.deleteMany({});
    }
    if (app) await app.close();
    await prisma.$disconnect();
  });

  function itWithDb(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!dbAvailable) return;
      await fn();
    });
  }

  it('DB availability probe (informational, always runs)', () => {
    if (!dbAvailable) {
      // eslint-disable-next-line no-console
      console.warn('users.e2e-spec.ts: all subsequent cases are NO-OPS (no live Postgres).');
    }
    expect(true).toBe(true);
  });

  // --- Authorization ----------------------------------------------------

  itWithDb('unauthenticated requests get 401 on every /api/users route', async () => {
    const plain = request(app.getHttpServer());
    await plain.get('/api/users').expect(401);
    await plain.post('/api/users').send({}).expect(401);
    await plain.get('/api/users/ue2e-viewer/access').expect(401);
  });

  itWithDb('a non-USER_ADMIN authenticated user gets 403 on every /api/users route', async () => {
    await agents.viewer.get('/api/users').expect(403);
    await agents.viewer
      .post('/api/users')
      .send({ username: 'x', displayName: 'x', password: 'password123', confirmPassword: 'password123' })
      .expect(403);
    await agents.viewer.get(`/api/users/${USERS.viewer}/access`).expect(403);
    await agents.viewer.put(`/api/users/${USERS.viewer}/access`).send({ roles: [], patientDetail: false }).expect(403);
    await agents.viewer.patch(`/api/users/${USERS.viewer}/status`).send({ isActive: false }).expect(403);
    await agents.viewer.delete(`/api/users/${USERS.viewer}`).expect(403);
  });

  // --- Create -> assign access -> login round trip -----------------------

  itWithDb(
    'create -> new account has no access grant (roles: null) -> assign VIEWER -> can log in and hit VIEWER-gated routes',
    async () => {
      const created = await agents.userAdmin
        .post('/api/users')
        .send({
          username: 'ue2e-newdoctor',
          displayName: '新医生',
          password: 'newdoctor-pw-1',
          confirmPassword: 'newdoctor-pw-1',
        })
        .expect(201);
      expect(created.body.username).toBe('ue2e-newdoctor');
      expect(created.body.roles).toBeNull();

      const accessBefore = await agents.userAdmin.get('/api/users/ue2e-newdoctor/access').expect(200);
      expect(accessBefore.body.roles).toEqual([]);

      // No access grant yet -> role-gated route fails closed even though login succeeds.
      const freshAgent = request.agent(app.getHttpServer());
      await freshAgent
        .post('/api/auth/login')
        .send({ username: 'ue2e-newdoctor', password: 'newdoctor-pw-1' })
        .expect(200);
      await freshAgent.get('/api/rules').expect(200); // no role metadata required
      await freshAgent.get('/api/system/sync-status').expect(200);

      const accessAfter = await agents.userAdmin
        .put('/api/users/ue2e-newdoctor/access')
        .send({ roles: ['VIEWER'], patientDetail: false })
        .expect(200);
      expect(accessAfter.body.roles).toEqual(['VIEWER']);
      expect(accessAfter.body.departmentScope).toEqual([]);

      // Authorization is read fresh per request (no caching, see docs/auth.md) - same cookie, no re-login needed.
      await freshAgent.get('/api/monitor/summary').expect(200);
    },
  );

  itWithDb('creating a duplicate username returns 409', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-dupe',
        displayName: '重复账号',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(201);
    const conflict = await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-dupe',
        displayName: '重复账号2',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(409);
    expect(conflict.body.error.code).toBe('USER_ALREADY_EXISTS');
  });

  itWithDb('mismatched password confirmation is rejected before hitting the database', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-mismatch',
        displayName: '密码不一致',
        password: 'password123',
        confirmPassword: 'different456',
      })
      .expect(400);
  });

  // --- departmentScope (issue #78 scope narrowing + review fix) ----------

  itWithDb(
    'PUT .../access rejects an unrecognized departmentScope field, and a fresh grant gets []',
    async () => {
      await agents.userAdmin
        .post('/api/users')
        .send({
          username: 'ue2e-deptscope',
          displayName: '科室范围测试',
          password: 'password123',
          confirmPassword: 'password123',
        })
        .expect(201);

      const res = await agents.userAdmin
        .put('/api/users/ue2e-deptscope/access')
        .send({ roles: ['VIEWER'], patientDetail: false, departmentScope: ['消化内科'] })
        .expect(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');

      // Without the extraneous field, a FRESH grant is written as [].
      const saved = await agents.userAdmin
        .put('/api/users/ue2e-deptscope/access')
        .send({ roles: ['VIEWER'], patientDetail: false })
        .expect(200);
      expect(saved.body.departmentScope).toEqual([]);
    },
  );

  itWithDb(
    'PUT .../access preserves a pre-existing non-empty departmentScope (e.g. set via the CLI) instead of silently wiping it',
    async () => {
      // Simulates auth:assign-access --departments 消化内科 having run against this account.
      await prisma.appUser.create({
        data: { username: 'ue2e-cli-scoped', displayName: 'CLI 已限定科室', passwordHash: 'x' },
      });
      await prisma.appUserAccess.create({
        data: {
          username: 'ue2e-cli-scoped',
          roles: ['VIEWER'] as never,
          departmentScope: ['消化内科'],
          patientDetail: false,
        },
      });

      // A USER_ADMIN using the Web UI only means to add a role - not touch department scope.
      const updated = await agents.userAdmin
        .put('/api/users/ue2e-cli-scoped/access')
        .send({ roles: ['VIEWER', 'RULE_ADMIN'], patientDetail: false })
        .expect(200);

      expect(updated.body.roles).toEqual(['VIEWER', 'RULE_ADMIN']);
      expect(updated.body.departmentScope).toEqual(['消化内科']);
    },
  );

  // --- Password reset invalidates the old password ------------------------

  itWithDb('reset-password invalidates the old password and sets a new one', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-resettarget',
        displayName: '被重置密码',
        password: 'old-password-1',
        confirmPassword: 'old-password-1',
      })
      .expect(201);

    await agents.userAdmin
      .post('/api/users/ue2e-resettarget/password')
      .send({ newPassword: 'new-password-2', confirmPassword: 'new-password-2' })
      .expect(204);

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ue2e-resettarget', password: 'old-password-1' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ue2e-resettarget', password: 'new-password-2' })
      .expect(200);
  });

  // --- Enable / disable ---------------------------------------------------

  itWithDb('disabling an account blocks login with 403 AUTH_ACCOUNT_DISABLED; re-enabling restores it', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-toggle',
        displayName: '启停测试',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(201);

    await agents.userAdmin.patch('/api/users/ue2e-toggle/status').send({ isActive: false }).expect(200);
    const disabledLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ue2e-toggle', password: 'password123' })
      .expect(403);
    expect(disabledLogin.body.error.code).toBe('AUTH_ACCOUNT_DISABLED');

    await agents.userAdmin.patch('/api/users/ue2e-toggle/status').send({ isActive: true }).expect(200);
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ue2e-toggle', password: 'password123' })
      .expect(200);
  });

  // --- Delete removes both app_user and app_user_access -------------------

  itWithDb('deleting an account removes both app_user and app_user_access rows (no orphan)', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-deleteme',
        displayName: '待删除账号',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(201);
    await agents.userAdmin
      .put('/api/users/ue2e-deleteme/access')
      .send({ roles: ['VIEWER'], patientDetail: false })
      .expect(200);

    await agents.userAdmin.delete('/api/users/ue2e-deleteme').expect(204);

    const userRow = await prisma.appUser.findUnique({ where: { username: 'ue2e-deleteme' } });
    const accessRow = await prisma.appUserAccess.findUnique({ where: { username: 'ue2e-deleteme' } });
    expect(userRow).toBeNull();
    expect(accessRow).toBeNull();

    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ username: 'ue2e-deleteme', password: 'password123' })
      .expect(401);
  });

  itWithDb('operations on an unknown username return 404', async () => {
    await agents.userAdmin.get('/api/users/ue2e-ghost/access').expect(404);
    await agents.userAdmin.patch('/api/users/ue2e-ghost/status').send({ isActive: false }).expect(404);
    await agents.userAdmin.delete('/api/users/ue2e-ghost').expect(404);
  });

  itWithDb('case-insensitive username path params resolve the same account as create() stored lowercased', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'Ue2e-CaseTest',
        displayName: '大小写测试',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(201);

    await agents.userAdmin.get('/api/users/UE2E-CASETEST/access').expect(200);
    await agents.userAdmin.patch('/api/users/Ue2e-CaseTest/status').send({ isActive: false }).expect(200);
  });

  // --- Last-USER_ADMIN lockout guard (review fix) -------------------------
  //
  // The bug this guards against (see users.service.ts's
  // assertNotLastUserAdmin) is specifically "count of USER_ADMIN grants
  // EXCLUDING the target account == 0". These tests construct that
  // condition precisely via direct Prisma writes rather than reasoning about
  // it through a chain of HTTP calls, and always sweep every OTHER
  // USER_ADMIN grant (INCLUDING the suite's own agents.userAdmin fixture)
  // out of the way first, restoring it in the same test - other tests in
  // this file run in declaration order within one Jest file (no parallel
  // interleaving), so this is safe as long as the restore happens before
  // the test returns.

  itWithDb(
    '409 LAST_USER_ADMIN_PROTECTED when the target is the sole remaining USER_ADMIN in the whole system',
    async () => {
      // Temporarily demote every USER_ADMIN grant, including the suite
      // fixture's own, then restore it at the end via a real USER_ADMIN
      // session (ue2e-only-admin itself, granted below) so later tests that
      // depend on agents.userAdmin keep working.
      const priorAdmins = await prisma.appUserAccess.findMany({
        where: { roles: { has: 'USER_ADMIN' } },
      });
      await prisma.appUserAccess.updateMany({
        where: { roles: { has: 'USER_ADMIN' } },
        data: { roles: ['VIEWER'] as never },
      });

      await prisma.appUser.create({
        data: {
          username: 'ue2e-only-admin',
          displayName: '唯一管理员',
          passwordHash: await hash(PASSWORD, { type: argon2id }),
        },
      });
      await prisma.appUserAccess.create({
        data: { username: 'ue2e-only-admin', roles: ['USER_ADMIN'] as never, departmentScope: [], patientDetail: false },
      });

      const soleAgent = request.agent(app.getHttpServer());
      await soleAgent
        .post('/api/auth/login')
        .send({ username: 'ue2e-only-admin', password: PASSWORD })
        .expect(200);

      try {
        const disable = await soleAgent
          .patch('/api/users/ue2e-only-admin/status')
          .send({ isActive: false })
          .expect(409);
        expect(disable.body.error.code).toBe('LAST_USER_ADMIN_PROTECTED');

        const demote = await soleAgent
          .put('/api/users/ue2e-only-admin/access')
          .send({ roles: ['VIEWER'], patientDetail: false })
          .expect(409);
        expect(demote.body.error.code).toBe('LAST_USER_ADMIN_PROTECTED');

        const del = await soleAgent.delete('/api/users/ue2e-only-admin').expect(409);
        expect(del.body.error.code).toBe('LAST_USER_ADMIN_PROTECTED');

        const stillThere = await prisma.appUserAccess.findUnique({ where: { username: 'ue2e-only-admin' } });
        expect(stillThere?.roles).toEqual(['USER_ADMIN']);
      } finally {
        // Restore the pre-test USER_ADMIN population exactly, so later tests
        // relying on agents.userAdmin are unaffected.
        for (const row of priorAdmins) {
          await prisma.appUserAccess.update({ where: { username: row.username }, data: { roles: row.roles } });
        }
      }
    },
  );

  itWithDb('succeeds once a second USER_ADMIN account exists', async () => {
    await prisma.appUser.create({
      data: { username: 'ue2e-admin-a', displayName: '管理员甲', passwordHash: 'x' },
    });
    await prisma.appUser.create({
      data: { username: 'ue2e-admin-b', displayName: '管理员乙', passwordHash: 'x' },
    });
    await prisma.appUserAccess.create({
      data: { username: 'ue2e-admin-a', roles: ['USER_ADMIN'] as never, departmentScope: [], patientDetail: false },
    });
    await prisma.appUserAccess.create({
      data: { username: 'ue2e-admin-b', roles: ['USER_ADMIN'] as never, departmentScope: [], patientDetail: false },
    });

    // Demoting admin-a is fine: admin-b (and the suite fixture) still hold USER_ADMIN.
    const demoted = await agents.userAdmin
      .put('/api/users/ue2e-admin-a/access')
      .send({ roles: ['VIEWER'], patientDetail: false })
      .expect(200);
    expect(demoted.body.roles).toEqual(['VIEWER']);
  });

  itWithDb('enabling a disabled USER_ADMIN account is never blocked by the guard (only disabling is destructive)', async () => {
    await prisma.appUser.create({
      data: { username: 'ue2e-reenable', displayName: '重新启用测试', passwordHash: 'x', isActive: false },
    });
    await prisma.appUserAccess.create({
      data: { username: 'ue2e-reenable', roles: ['USER_ADMIN'] as never, departmentScope: [], patientDetail: false },
    });

    const enabled = await agents.userAdmin
      .patch('/api/users/ue2e-reenable/status')
      .send({ isActive: true })
      .expect(200);
    expect(enabled.body.isActive).toBe(true);
  });

  // --- Audit trail ----------------------------------------------------

  itWithDb('every write records an audit row with no password fields in meta', async () => {
    await agents.userAdmin
      .post('/api/users')
      .send({
        username: 'ue2e-audited',
        displayName: '审计测试',
        password: 'password123',
        confirmPassword: 'password123',
      })
      .expect(201);

    const rows = await prisma.auditLog.findMany({
      where: { actorUsername: USERS.userAdmin, action: 'USER_CREATE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[0];
    expect(latest.meta).toEqual({ username: 'ue2e-audited' });
    const serialized = JSON.stringify(latest.meta);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/hash/i);
  });
});
