import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
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
  /** attention_semantic rows this suite created (issue #88), for cleanup. */
  const semanticIds: string[] = [];
  let ruleId: string;

  const KEYWORD = '腺癌早期';

  /**
   * Issue #88 (PR-B): the report-level AI explanation attached to A1. Kept as
   * constants because the masking assertions below have to name the exact
   * strings that must NOT survive: the model's own sentence and two verbatim
   * excerpts, both report-adjacent free text.
   */
  const AI_REASON = '报告描述了隆起性病变并提示黏膜内腺癌早期。';
  const AI_EVIDENCE_FINDINGS = '一处隆起性病变'; // A1 reportContent.slice(3, 10)
  const AI_EVIDENCE_IMPRESSION = '胃腺癌'; // A1 diagnosis.slice(0, 3)
  const AI_SEMANTIC_NAME = '明确或高度疑似恶性病变';

  function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

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
          // Issue #88: A1 carries a completed AI classification, so the
          // masking and audit assertions below run against a record whose
          // level has TWO contributors. The others stay unjudged.
          ...(row.key === 'A1'
            ? { aiAttentionLevel: 'RED' as never, aiResolvedAt: new Date('2026-08-20T08:16:00Z') }
            : {}),
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

    // Issue #88: the audit rows behind A1's AI level. Append-only and written
    // here exactly as the worker writes them - the excerpt itself is NOT
    // stored, only its hash and offsets, which is what makes the doctor-facing
    // reconstruction a real test rather than a read-back.
    const semantic = await prisma.attentionSemantic.create({
      data: {
        semanticGroupId: randomUUID(),
        name: AI_SEMANTIC_NAME,
        description: '报告描述了提示恶性或高度可疑恶性的表现。',
        attentionLevel: 'RED',
        createdBy: 'security-e2e',
        updatedBy: 'security-e2e',
      },
    });
    semanticIds.push(semantic.id);
    const attempt = await prisma.monitorReportAi.create({
      data: {
        monitorRecordId: ids.A1,
        reportVersion: 1,
        task: 'CLASSIFY_REPORT',
        taskVersion: 'security-e2e-1',
        outcome: 'OK',
        attentionLevel: 'RED',
        modelAttentionLevel: 'RED',
        semanticCount: 1,
        matchCount: 1,
        model: 'security-e2e-model',
        inputHash: sha256Hex('input'),
        reportHash: sha256Hex('report'),
        configHash: sha256Hex('config'),
        createdAt: new Date('2026-08-20T08:16:00Z'),
      },
    });
    const match = await prisma.monitorReportAiMatch.create({
      data: {
        reportAiId: attempt.id,
        semanticId: semantic.id,
        semanticVersion: semantic.version,
        semanticName: AI_SEMANTIC_NAME,
        attentionLevel: 'RED',
        confidence: 'HIGH',
        reason: AI_REASON,
        ordinal: 0,
      },
    });
    await prisma.monitorReportAiEvidence.createMany({
      data: [
        {
          matchId: match.id,
          ordinal: 0,
          field: 'FINDINGS',
          evidenceHash: sha256Hex(AI_EVIDENCE_FINDINGS),
          evidenceStart: 3,
          evidenceEnd: 10,
        },
        {
          matchId: match.id,
          ordinal: 1,
          field: 'IMPRESSION',
          evidenceHash: sha256Hex(AI_EVIDENCE_IMPRESSION),
          evidenceStart: 0,
          evidenceEnd: 3,
        },
      ],
    });
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
    await prisma.attentionSemantic.deleteMany({});

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
      // After the records: monitor_report_ai_match references attention_semantic
      // with onDelete: Restrict, so the matches must be cascaded away first.
      await prisma.attentionSemantic.deleteMany({ where: { id: { in: semanticIds } } });
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

  itWithDb(
    'the list read also writes an EXAM_LIST audit row without the raw patientName value',
    async () => {
      await agents.viewer.get('/api/monitor/exams').query({ patientName: '测试患者甲' }).expect(200);

      const rows = await prisma.auditLog.findMany({
        where: { action: 'EXAM_LIST', actorUsername: USERS.viewer },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(rows.length).toBeGreaterThan(0);
      const meta = rows[0].meta as Record<string, unknown>;
      // hadPatientName is a flag only - the actual search string (a
      // possible patient name) must never be stored.
      expect(meta.hadPatientName).toBe(true);
      expect(JSON.stringify(meta)).not.toMatch(/测试患者甲/);
    },
  );

  // --- Issue #88: the AI explanation crosses the same masking boundary ------

  itWithDb(
    'the same AI finding is a verdict for a masked caller and a quote for an unmasked one',
    async () => {
      // One record (A1), two callers. The ONLY difference between them is the
      // patientDetail grant.
      const full = await agents.viewerFull.get(`/api/monitor/exams/${ids.A1}`).expect(200);
      const masked = await agents.viewer.get(`/api/monitor/exams/${ids.A1}`).expect(200);

      // Unmasked: the model's sentence and both verbatim excerpts, recomputed
      // from the stored offsets rather than read back from a stored quote.
      expect(full.body.dataAccess).toBeUndefined();
      expect(full.body.attentionSource).toBe('BOTH');
      expect(full.body.aiJudged).toBe(true);
      expect(full.body.aiSemantics).toHaveLength(1);
      expect(full.body.aiSemantics[0].reason).toBe(AI_REASON);
      expect(full.body.aiSemantics[0].evidence).toEqual([
        { field: 'FINDINGS', text: AI_EVIDENCE_FINDINGS },
        { field: 'IMPRESSION', text: AI_EVIDENCE_IMPRESSION },
      ]);

      // Masked: the model's sentence and every excerpt are report-adjacent free
      // text, so both go...
      expect(masked.body.dataAccess).toEqual({ masked: true });
      expect(masked.body.aiSemantics[0].reason).toBeNull();
      expect(masked.body.aiSemantics[0].evidence).toEqual([]);
      // ...while the finding itself stays. Dropping it would leave a record the
      // AI alone flagged as RED with nothing on screen to explain why.
      expect(masked.body.aiSemantics[0].name).toBe(AI_SEMANTIC_NAME);
      expect(masked.body.aiSemantics[0].attentionLevel).toBe('RED');
      expect(masked.body.aiSemantics[0].confidence).toBe('HIGH');
      // Which path produced the level is provenance, not patient data - this
      // caller already sees the level itself.
      expect(masked.body.attentionSource).toBe('BOTH');

      // And none of it reaches the audit trail: the EXAM_DETAIL meta records
      // the level and the masking flag, never the excerpt or the model's words.
      const rows = await prisma.auditLog.findMany({
        where: { action: 'EXAM_DETAIL', actorUsername: USERS.viewer, resourceId: ids.A1 },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0].meta);
      expect(serialized).not.toMatch(
        /一处隆起性病变|胃腺癌|隆起性病变并提示|明确或高度疑似|reportContent|diagnosis/,
      );
    },
  );
});
