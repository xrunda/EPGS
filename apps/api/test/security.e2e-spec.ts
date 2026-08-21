import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';

/**
 * Full-stack e2e for issue #13's security cross-cut against a REAL Postgres:
 * role-based authorization (RolesGuard layered on #31's JWT auth), the
 * department data-scope + patient-data masking by access grant, and the
 * read-only audit trail. It exercises the full permission matrix, horizontal
 * escalation (scoped user fetching an out-of-scope record -> 404, never 403),
 * server-authoritative actor on rule writes (tampered actorId is ignored),
 * and audit-row hygiene (meta never carries report body / patient name).
 *
 * Same itWithDb no-op-on-unreachable-DB pattern as the monitor/rules suites,
 * so the DB-free CI job stays untouched; runs for real in the db-migrations
 * job. afterAll cleans audit_log -> app_user_access -> app_user ->
 * monitor_match -> monitor_record -> monitor_rule so the seed-count step
 * still sees exactly the 6 seeded RED rules.
 */
describe('Security (e2e, real Postgres): roles, scope, masking, audit', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  const PASSWORD = 'security-e2e-password';

  const USERS = {
    viewer: 'sec-viewer', // VIEWER, scoped 消化内科, no patientDetail
    viewerFull: 'sec-viewer-full', // VIEWER, scoped 消化内科, patientDetail
    ruleAdmin: 'sec-ruleadmin', // RULE_ADMIN, no scope
    sysAdmin: 'sec-sysadmin', // SYSTEM_ADMIN, no scope, no patientDetail
    auditor: 'sec-auditor', // AUDITOR
  } as const;

  type Agent = ReturnType<typeof request.agent>;
  const agents: Record<keyof typeof USERS, Agent> = {} as never;

  /** record.id per fixture key (mutated in place by seedFixture). */
  const ids: Record<string, string> = {};
  let ruleId: string;

  const KEYWORD = '腺癌早期';

  async function seedFixture(): Promise<void> {
    // Two departments so the data-scope tests can distinguish in/out of scope.
    const records: {
      key: string;
      patientName: string;
      department: string;
      bedNo: string;
      currentLevel: string;
      reportContent: string;
      diagnosis: string | null;
      matchedKeyword: string;
    }[] = [
      {
        key: 'A1',
        patientName: '测试患者甲',
        department: '消化内科',
        bedNo: '12-1',
        currentLevel: 'RED',
        reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌早期。',
        diagnosis: '胃腺癌（早期）。',
        matchedKeyword: KEYWORD,
      },
      {
        key: 'A2',
        patientName: '测试患者乙',
        department: '消化内科',
        bedNo: '12-2',
        currentLevel: 'YELLOW',
        reportContent: '胃体见多发息肉样隆起。',
        diagnosis: null,
        matchedKeyword: '息肉样',
      },
      {
        key: 'B1',
        patientName: '测试患者丙',
        department: '呼吸内科',
        bedNo: '3-1',
        currentLevel: 'GREEN',
        reportContent: '气道黏膜慢性炎症改变。',
        diagnosis: '气道炎症。',
        matchedKeyword: '气道炎症',
      },
    ];

    ruleId = randomUUID();
    await prisma.monitorRule.create({
      data: {
        id: ruleId,
        keyword: KEYWORD,
        level: 'RED' as never,
        matchField: 'REPORT_TEXT' as never,
        ruleGroupId: ruleId,
        createdBy: 'security-e2e',
        updatedBy: 'security-e2e',
      },
    });
    const ruleByKeyword: Record<string, string> = { [KEYWORD]: ruleId };
    for (const keyword of ['息肉样', '气道炎症']) {
      const id = randomUUID();
      await prisma.monitorRule.create({
        data: {
          id,
          keyword,
          level: (keyword === '息肉样' ? 'YELLOW' : 'GREEN') as never,
          matchField: 'FINDINGS' as never,
          ruleGroupId: id,
          createdBy: 'security-e2e',
          updatedBy: 'security-e2e',
        },
      });
      ruleByKeyword[keyword] = id;
    }

    for (const row of records) {
      const record = await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `TEST-SEC-${row.key}`,
          reportId: `TEST-SEC-${row.key}`,
          reportVersion: 1,
          sourceUpdatedAt: new Date('2026-08-20T08:15:00Z'),
          patientName: row.patientName,
          department: row.department,
          bedNo: row.bedNo,
          patientTypeCode: 'I',
          patientTypeName: '住院',
          examItem: '电子胃镜检查',
          examTime: new Date('2026-08-20T08:15:00Z'),
          currentLevel: row.currentLevel as never,
          firstMatchedAt: new Date('2026-08-20T08:15:30Z'),
          lastMatchedAt: new Date('2026-08-20T08:15:30Z'),
          reportContent: row.reportContent,
          diagnosis: row.diagnosis,
        },
      });
      ids[row.key] = record.id;
      await prisma.monitorMatch.create({
        data: {
          monitorRecordId: record.id,
          ruleId: ruleByKeyword[row.matchedKeyword],
          keyword: row.matchedKeyword,
          level: row.currentLevel as never,
          matchedField:
            row.matchedKeyword === KEYWORD ? ('REPORT_TEXT' as never) : ('FINDINGS' as never),
          contextSnippet: row.matchedKeyword === KEYWORD ? '…腺癌早期…' : '…matched…',
          reportVersion: 1,
          matchedAt: new Date('2026-08-20T08:15:30Z'),
        },
      });
    }
  }

  async function createUser(username: string, displayName: string): Promise<void> {
    await prisma.appUser.create({
      data: { username, displayName, passwordHash: await hash(PASSWORD, { type: argon2id }) },
    });
  }

  async function grantAccess(
    username: string,
    roles: string[],
    departmentScope: string[],
    patientDetail: boolean,
  ): Promise<void> {
    await prisma.appUserAccess.create({
      data: {
        username,
        roles: roles as never,
        departmentScope,
        patientDetail,
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.monitorRecord.findFirst();
      await prisma.appUser.findFirst();
      await prisma.appUserAccess.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping security e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}).`,
      );
      return;
    }

    // Self-contained: wipe every table this suite asserts exact totals on, so
    // a local re-run or residue from earlier suites never shifts the counts.
    // In the CI db-migrations job earlier suites have already cleaned up, so
    // this is a no-op there; the seed-count step runs strictly after this
    // suite's afterAll.
    await prisma.auditLog.deleteMany({});
    await prisma.appUserAccess.deleteMany({});
    await prisma.appUser.deleteMany({});
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    await prisma.monitorRule.deleteMany({});

    await seedFixture();

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

    await createUser(USERS.viewer, '查看者');
    await createUser(USERS.viewerFull, '全量查看者');
    await createUser(USERS.ruleAdmin, '规则管理员');
    await createUser(USERS.sysAdmin, '系统管理员');
    await createUser(USERS.auditor, '审计员');

    await grantAccess(USERS.viewer, ['VIEWER'], ['消化内科'], false);
    await grantAccess(USERS.viewerFull, ['VIEWER'], ['消化内科'], true);
    await grantAccess(USERS.ruleAdmin, ['RULE_ADMIN'], [], false);
    await grantAccess(USERS.sysAdmin, ['SYSTEM_ADMIN'], [], false);
    await grantAccess(USERS.auditor, ['AUDITOR'], [], false);

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
      await prisma.monitorMatch.deleteMany({});
      await prisma.monitorRecord.deleteMany({});
      await prisma.monitorRule.deleteMany({});
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
      console.warn('security.e2e-spec.ts: all subsequent cases are NO-OPS (no live Postgres).');
    }
    expect(true).toBe(true);
  });

  async function expectForbidden(res: request.Response): Promise<void> {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  }

  // --- Unauthenticated ------------------------------------------------

  itWithDb(
    'unauthenticated requests get 401 on every protected route; health stays 200',
    async () => {
      const plain = request(app.getHttpServer());
      await plain.get('/api/monitor/exams').expect(401);
      await plain.get('/api/monitor/summary').expect(401);
      await plain.get('/api/rules').expect(401);
      await plain.get('/api/audit').expect(401);
      await plain.get('/api/system/sync-status').expect(401);
      await plain.get('/health').expect(200);
    },
  );

  // --- Permission matrix ----------------------------------------------

  itWithDb('VIEWER (scoped, no detail) reads scoped masked data; writes/audit 403', async () => {
    const list = await agents.viewer.get('/api/monitor/exams').expect(200);
    expect(list.body.total).toBe(2); // only 消化内科 A1 + A2
    expect(list.body.dataAccess).toEqual({ masked: true });
    expect(list.body.items.every((i: { department: string }) => i.department === '消化内科')).toBe(
      true,
    );
    // patientName masked, bedNo obscured.
    expect(list.body.items[0].patientName).toMatch(/\*+/);
    expect(list.body.items[0].bedNo).toBe('***');

    const detail = await agents.viewer.get(`/api/monitor/exams/${ids.A1}`).expect(200);
    expect(detail.body.reportContent).toBeNull();
    expect(detail.body.diagnosis).toBeNull();
    expect(detail.body.dataAccess).toEqual({ masked: true });

    await agents.viewer.get('/api/monitor/summary').expect(200);
    await agents.viewer.get('/api/rules').expect(200);
    await agents.viewer.get('/api/system/sync-status').expect(200);
    await expectForbidden(
      await agents.viewer
        .post('/api/rules')
        .send({ keyword: 'x', level: 'RED', matchField: 'REPORT_TEXT' }),
    );
    await expectForbidden(await agents.viewer.get('/api/audit'));
  });

  itWithDb('VIEWER with patientDetail reads scoped data unmasked', async () => {
    const list = await agents.viewerFull.get('/api/monitor/exams').expect(200);
    expect(list.body.total).toBe(2);
    // No dataAccess flag when unmasked - redaction is distinguishable from an
    // empty report body.
    expect(list.body).not.toHaveProperty('dataAccess');
    expect(list.body.items[0].patientName).toBe('测试患者甲');

    const detail = await agents.viewerFull.get(`/api/monitor/exams/${ids.A1}`).expect(200);
    expect(detail.body.reportContent).toBe('胃窦见一处隆起性病变，病理提示黏膜内腺癌早期。');
    expect(detail.body.diagnosis).toBe('胃腺癌（早期）。');
    expect(detail.body.hits[0].contextSnippet).toBe('…腺癌早期…');
    expect(detail.body).not.toHaveProperty('dataAccess');
  });

  itWithDb(
    'horizontal escalation: a scoped user fetching an out-of-scope record gets 404',
    async () => {
      // 404, not 403 - the response must not reveal that B1 exists.
      const res = await agents.viewer.get(`/api/monitor/exams/${ids.B1}`).expect(404);
      expect(res.body.error.code).toBe('MONITOR_RECORD_NOT_FOUND');
      // The list is scope-narrowed too - B1 never appears.
      const list = await agents.viewer.get('/api/monitor/exams').expect(200);
      expect(list.body.items.some((i: { recordId: string }) => i.recordId === ids.B1)).toBe(false);
    },
  );

  itWithDb('RULE_ADMIN writes rules; server-side actor overrides a tampered actorId', async () => {
    const createRes = await agents.ruleAdmin
      .post('/api/rules')
      .send({ keyword: '黏膜内腺癌', level: 'RED', matchField: 'REPORT_TEXT', actorId: 'mallory' })
      .expect(201);
    const ruleIdCreated = createRes.body.id;

    const stored = await prisma.monitorRule.findUniqueOrThrow({ where: { id: ruleIdCreated } });
    expect(stored.createdBy).toBe(USERS.ruleAdmin); // NOT 'mallory'
    expect(stored.updatedBy).toBe(USERS.ruleAdmin);

    // The audit row records the real actor.
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'RULE_CREATE', actorUsername: USERS.ruleAdmin },
    });
    expect(auditRow.actorUsername).toBe(USERS.ruleAdmin);
    expect(JSON.stringify(auditRow.meta)).not.toMatch(
      /patientName|reportContent|diagnosis|contextSnippet/,
    );

    await agents.ruleAdmin.get('/api/monitor/exams').expect(200);
    await expectForbidden(await agents.ruleAdmin.get('/api/audit'));
  });

  itWithDb('SYSTEM_ADMIN reads masked monitor data; cannot write rules or read audit', async () => {
    const list = await agents.sysAdmin.get('/api/monitor/exams').expect(200);
    expect(list.body.total).toBe(3); // no scope = all departments
    expect(list.body.dataAccess).toEqual({ masked: true }); // no patientDetail by default

    await expectForbidden(
      await agents.sysAdmin
        .post('/api/rules')
        .send({ keyword: 'x', level: 'RED', matchField: 'REPORT_TEXT' }),
    );
    await expectForbidden(await agents.sysAdmin.get('/api/audit'));
  });

  itWithDb('AUDITOR reads the audit trail; monitor and rule writes are 403', async () => {
    const res = await agents.auditor.get('/api/audit').expect(200);
    expect(res.body.items).toBeDefined();
    expect(res.body.total).toBeGreaterThan(0);

    await expectForbidden(await agents.auditor.get('/api/monitor/exams'));
    await expectForbidden(
      await agents.auditor
        .post('/api/rules')
        .send({ keyword: 'x', level: 'RED', matchField: 'REPORT_TEXT' }),
    );
    await agents.auditor.get('/health').expect(200);
  });

  // --- Audit trail hygiene --------------------------------------------

  itWithDb('every read is audited and audit meta never carries patient data', async () => {
    // Trigger an EXAM_DETAIL read (masked path).
    await agents.viewer.get(`/api/monitor/exams/${ids.A1}`).expect(200);

    const detailRows = await prisma.auditLog.findMany({
      where: { action: 'EXAM_DETAIL', actorUsername: USERS.viewer },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(detailRows.length).toBeGreaterThan(0);
    const meta = detailRows[0].meta as Record<string, unknown>;
    // Only LOW-sensitivity fields.
    expect(meta.masked).toBe(true);
    expect(meta.level).toBe('RED');
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toMatch(/测试患者|胃窦|腺癌早期|contextSnippet/);
    expect(detailRows[0].resourceId).toBe(ids.A1);
    expect(detailRows[0].department).toBe('消化内科');
  });

  itWithDb('the list read also writes an EXAM_LIST audit row without the raw q value', async () => {
    await agents.viewer.get('/api/monitor/exams').query({ q: '测试患者甲' }).expect(200);

    const rows = await prisma.auditLog.findMany({
      where: { action: 'EXAM_LIST', actorUsername: USERS.viewer },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(rows.length).toBeGreaterThan(0);
    const meta = rows[0].meta as Record<string, unknown>;
    // hadQ is a flag only - the actual search string (a possible patient
    // name) must never be stored.
    expect(meta.hadQ).toBe(true);
    expect(JSON.stringify(meta)).not.toMatch(/测试患者甲/);
  });
});
