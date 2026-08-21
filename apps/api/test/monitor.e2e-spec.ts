import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';

/**
 * Full-stack e2e test for issue #7's read-only monitor workbench API and
 * issue #8's detail/hit-evidence contract (`GET /api/monitor/exams`,
 * `GET /api/monitor/exams/:id`, `GET /api/monitor/summary`) against a REAL
 * Postgres instance. The #8 detail tests assert each hit's rule provenance
 * (ruleId/ruleVersion) and its report-field location (matchedField → 报告内容/
 * 诊断) in addition to the #7 snapshot fields.
 *
 * The suite is purely read-only (the API writes nothing), so the synthetic
 * fixture is seeded ONCE in beforeAll and never re-wiped between tests -
 * unlike the rules e2e suite, whose tests mutate rows. The fixture's 6
 * rules + 12 records cover the acceptance matrix: cross-day Asia/Shanghai
 * boundaries (R3 stored at UTC 08-19 → displays/`filters` as Shanghai
 * 08-20), exact day edges (R11 at Shanghai 00:00, R12 at 23:59), null
 * examTime/name/department/bedNo (R7), unknown patientType code X with a
 * confirmed-null name (R12), multi-keyword (R1), keyword dedupe (R9),
 * same-timestamp RED>YELLOW tie-break (R9/R10), and a report body
 * containing a keyword that must NOT be searched by `q` (R12) to prove the
 * fuzzy search is scoped to name+matched keyword.
 *
 * CRITICAL for CI: afterAll wipes monitor_match → monitor_record →
 * monitor_rule (in FK order). The later CI seed-count step asserts exactly
 * 6 enabled RED rules after seeding - it stays green only because this
 * suite removes its own rules on the way out.
 */
describe('Monitor API (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let agent: ReturnType<typeof request.agent>;
  const authUsername = 'monitor-e2e-user';
  const authPassword = 'synthetic-monitor-password';

  /** record.id per fixture key, captured at seed time. */
  let ids: Record<string, string> = {};

  /** monitor_rule.id per fixture rule key (rule-1..rule-6), for hit-evidence assertions (issue #8). */
  let ruleIds: Record<string, string> = {};

  interface FixtureMatch {
    keyword: string;
    level: string;
    matchField: string;
    matchedAt: string;
    contextSnippet: string;
  }

  interface FixtureRecord {
    key: string;
    patientName: string | null;
    department: string | null;
    bedNo: string | null;
    patientTypeCode: string | null;
    patientTypeName: string | null;
    examItem: string | null;
    examTime: string | null;
    currentLevel: string;
    reportContent: string | null;
    diagnosis: string | null;
    matches: FixtureMatch[];
  }

  // Rule keywords are disjoint from the prisma/seed.ts keywords
  // (癌/肿瘤/肿物/Ca/食管裂孔疝/贲门失弛缓症) so the CI seed-count check
  // is unaffected even mid-suite.
  const FIXTURE_RULES = [
    { key: 'rule-1', keyword: '腺癌', level: 'RED', matchField: 'REPORT_TEXT' },
    { key: 'rule-2', keyword: '腺癌', level: 'RED', matchField: 'FINDINGS' },
    { key: 'rule-3', keyword: '浸润癌', level: 'RED', matchField: 'IMPRESSION' },
    { key: 'rule-4', keyword: '息肉样', level: 'YELLOW', matchField: 'FINDINGS' },
    { key: 'rule-5', keyword: '浅表胃炎', level: 'GREEN', matchField: 'FINDINGS' },
    { key: 'rule-6', keyword: '气道炎症', level: 'GREEN', matchField: 'FINDINGS' },
  ] as const;

  const FIXTURE_RECORDS: FixtureRecord[] = [
    {
      key: 'R1',
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '12-1',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T08:15:00Z', // Shanghai 08-20 16:15
      currentLevel: 'RED',
      reportContent: '胃窦见一处隆起性病变，病理提示黏膜内腺癌。',
      diagnosis: '胃腺癌（早期）。',
      matches: [
        {
          keyword: '腺癌',
          level: 'RED',
          matchField: 'REPORT_TEXT',
          matchedAt: '2026-08-20T08:15:30Z',
          contextSnippet: '…黏膜内腺癌…',
        },
        {
          keyword: '息肉样',
          level: 'YELLOW',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T08:15:45Z',
          contextSnippet: '…息肉样隆起…',
        },
      ],
    },
    {
      key: 'R2',
      patientName: '测试患者乙',
      department: '消化内科',
      bedNo: '12-2',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T08:30:00Z', // Shanghai 08-20 16:30
      currentLevel: 'YELLOW',
      reportContent: '胃体见多发息肉样隆起。',
      diagnosis: null,
      matches: [
        {
          keyword: '息肉样',
          level: 'YELLOW',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T08:30:00Z',
          contextSnippet: '…息肉样隆起…',
        },
      ],
    },
    {
      key: 'R3',
      patientName: '测试患者丙',
      department: '呼吸内科',
      bedNo: '3-1',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examItem: '支气管镜检查',
      examTime: '2026-08-19T16:30:00Z', // UTC 08-19 -> Shanghai 08-20 00:30 (cross-day)
      currentLevel: 'GREEN',
      reportContent: '气道黏膜慢性炎症改变。',
      diagnosis: '气道炎症。',
      matches: [
        {
          keyword: '气道炎症',
          level: 'GREEN',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-19T16:30:00Z',
          contextSnippet: '…气道炎症…',
        },
      ],
    },
    {
      key: 'R4',
      patientName: '测试患者丁',
      department: '消化内科',
      bedNo: '12-4',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T09:00:00Z', // Shanghai 08-20 17:00
      currentLevel: 'YELLOW',
      reportContent: '胃窦见息肉样新生物。',
      diagnosis: '胃息肉样病变。',
      matches: [
        {
          keyword: '息肉样',
          level: 'YELLOW',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T09:00:00Z',
          contextSnippet: '…息肉样新生物…',
        },
      ],
    },
    {
      key: 'R5',
      patientName: '测试患者戊',
      department: '消化内科',
      bedNo: '12-5',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T08:45:00Z', // Shanghai 08-20 16:45
      currentLevel: 'YELLOW',
      reportContent: '胃底见息肉样病变。',
      diagnosis: '胃息肉。',
      matches: [
        {
          keyword: '息肉样',
          level: 'YELLOW',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T08:45:00Z',
          contextSnippet: '…息肉样病变…',
        },
      ],
    },
    {
      key: 'R6',
      patientName: '测试患者己',
      department: '呼吸内科',
      bedNo: '3-6',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examItem: '支气管镜检查',
      examTime: '2026-08-19T12:00:00Z', // Shanghai 08-19 20:00
      currentLevel: 'GREEN',
      reportContent: '左主支气管黏膜充血，见气道炎症表现。',
      diagnosis: '气道炎症。',
      matches: [
        {
          keyword: '气道炎症',
          level: 'GREEN',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-19T12:00:00Z',
          contextSnippet: '…气道炎症表现…',
        },
      ],
    },
    {
      key: 'R7',
      patientName: null,
      department: null,
      bedNo: null,
      patientTypeCode: null,
      patientTypeName: null,
      examItem: null,
      examTime: null,
      currentLevel: 'UNCLASSIFIED',
      reportContent: null,
      diagnosis: null,
      matches: [],
    },
    {
      key: 'R8',
      patientName: '测试患者庚',
      department: '消化内科',
      bedNo: '12-8',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T10:00:00Z', // Shanghai 08-20 18:00 (latest)
      currentLevel: 'RED',
      reportContent: '贲门见浸润性病变，考虑浸润癌。',
      diagnosis: '贲门浸润癌。',
      matches: [
        {
          keyword: '浸润癌',
          level: 'RED',
          matchField: 'IMPRESSION',
          matchedAt: '2026-08-20T10:00:00Z',
          contextSnippet: '…考虑浸润癌…',
        },
      ],
    },
    {
      key: 'R9',
      patientName: '测试患者辛',
      department: '消化内科',
      bedNo: '12-9',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '电子胃镜检查',
      examTime: '2026-08-20T07:00:00Z', // Shanghai 08-20 15:00 (tie with R10)
      currentLevel: 'RED',
      reportContent: '胃体见腺癌组织。',
      diagnosis: '胃腺癌。',
      matches: [
        {
          keyword: '腺癌',
          level: 'RED',
          matchField: 'REPORT_TEXT',
          matchedAt: '2026-08-20T07:00:10Z',
          contextSnippet: '…腺癌组织…',
        },
        {
          keyword: '腺癌',
          level: 'RED',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T07:00:20Z',
          contextSnippet: '…腺癌…',
        },
      ],
    },
    {
      key: 'R10',
      patientName: '测试患者壬',
      department: '呼吸内科',
      bedNo: '3-10',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examItem: '支气管镜检查',
      examTime: '2026-08-20T07:00:00Z', // Shanghai 08-20 15:00 (tie with R9)
      currentLevel: 'YELLOW',
      reportContent: '右主支气管见息肉样隆起。',
      diagnosis: '支气管息肉。',
      matches: [
        {
          keyword: '息肉样',
          level: 'YELLOW',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-20T07:00:00Z',
          contextSnippet: '…息肉样隆起…',
        },
      ],
    },
    {
      key: 'R11',
      patientName: '测试患者癸',
      department: '消化内科',
      bedNo: '12-11',
      patientTypeCode: 'O',
      patientTypeName: '门诊',
      examItem: '电子胃镜检查',
      examTime: '2026-08-17T16:00:00Z', // Shanghai 08-18 00:00 (exact midnight)
      currentLevel: 'GREEN',
      reportContent: '胃窦黏膜浅表性炎症。',
      diagnosis: '浅表胃炎。',
      matches: [
        {
          keyword: '浅表胃炎',
          level: 'GREEN',
          matchField: 'FINDINGS',
          matchedAt: '2026-08-17T16:00:00Z',
          contextSnippet: '…浅表胃炎…',
        },
      ],
    },
    {
      key: 'R12',
      patientName: '测试患者子',
      department: null,
      bedNo: null,
      patientTypeCode: 'X',
      patientTypeName: null,
      examItem: null,
      examTime: '2026-08-17T15:59:00Z', // Shanghai 08-17 23:59
      currentLevel: 'UNCLASSIFIED',
      reportContent: '镜下见多发隆起，病理考虑腺癌可能。',
      diagnosis: null,
      matches: [], // no rule hit - UNCLASSIFIED despite report text containing 腺癌
    },
  ];

  async function seedFixture(): Promise<void> {
    const ruleIdByKey: Record<string, string> = {};
    for (const rule of FIXTURE_RULES) {
      const ruleId = randomUUID();
      await prisma.monitorRule.create({
        data: {
          id: ruleId,
          keyword: rule.keyword,
          level: rule.level as never,
          matchField: rule.matchField as never,
          ruleGroupId: ruleId,
          createdBy: 'tester',
          updatedBy: 'tester',
        },
      });
      ruleIdByKey[rule.key] = ruleId;
    }
    ruleIds = ruleIdByKey;
    // Resolve a rule id by (keyword, matchField) for match creation.
    const ruleIdByTuple = new Map<string, string>();
    for (const rule of FIXTURE_RULES) {
      ruleIdByTuple.set(`${rule.keyword}|${rule.matchField}`, ruleIdByKey[rule.key]);
    }

    const captured: Record<string, string> = {};
    for (const row of FIXTURE_RECORDS) {
      const examTime = row.examTime ? new Date(row.examTime) : null;
      const record = await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `TEST-MON-${row.key}`,
          reportId: `TEST-MON-${row.key}`,
          reportVersion: 1,
          sourceUpdatedAt: examTime ?? new Date('2026-08-17T16:00:00Z'),
          patientName: row.patientName,
          department: row.department,
          bedNo: row.bedNo,
          patientTypeCode: row.patientTypeCode,
          patientTypeName: row.patientTypeName,
          examItem: row.examItem,
          examTime,
          currentLevel: row.currentLevel as never,
          firstMatchedAt: row.matches.length ? new Date(row.matches[0].matchedAt) : null,
          lastMatchedAt: row.matches.length
            ? new Date(row.matches[row.matches.length - 1].matchedAt)
            : null,
          reportContent: row.reportContent,
          diagnosis: row.diagnosis,
        },
      });
      captured[row.key] = record.id;
      for (const match of row.matches) {
        const ruleId = ruleIdByTuple.get(`${match.keyword}|${match.matchField}`);
        if (!ruleId) throw new Error(`No fixture rule for ${match.keyword}|${match.matchField}`);
        await prisma.monitorMatch.create({
          data: {
            monitorRecordId: record.id,
            ruleId,
            keyword: match.keyword,
            level: match.level as never,
            matchedField: match.matchField as never,
            contextSnippet: match.contextSnippet,
            reportVersion: 1,
            matchedAt: new Date(match.matchedAt),
          },
        });
      }
    }
    ids = captured;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      // Fails fast if DATABASE_URL is unreachable or the monitor_* tables
      // don't exist yet (migration not applied).
      await prisma.$queryRaw`SELECT 1`;
      await prisma.monitorRecord.findFirst();
      await prisma.appUser.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping monitor e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite - see docs/api/monitor-api.md.',
      );
      return;
    }

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
    await prisma.appUser.deleteMany({ where: { username: authUsername } });
    await prisma.appUser.create({
      data: {
        username: authUsername,
        displayName: '监测接口测试用户',
        passwordHash: await hash(authPassword, { type: argon2id }),
      },
    });
    // Issue #13: RolesGuard requires an app_user_access grant. VIEWER with an
    // empty departmentScope (= all departments) and patientDetail=true keeps
    // the pre-#13 assertions byte-identical: all 12 fixture rows visible,
    // nothing masked.
    await prisma.appUserAccess.upsert({
      where: { username: authUsername },
      create: {
        username: authUsername,
        roles: ['VIEWER'] as never,
        departmentScope: [],
        patientDetail: true,
      },
      update: {
        roles: ['VIEWER'] as never,
        departmentScope: [],
        patientDetail: true,
      },
    });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ username: authUsername, password: authPassword })
      .expect(200);
  });

  afterAll(async () => {
    if (dbAvailable) {
      // FK order matters: matches reference records reference rules. Issue
      // #13 tables (audit_log, app_user_access) have no FKs - cleaned here so
      // the next suite (and the CI seed-count step) starts clean.
      await prisma.auditLog.deleteMany({});
      await prisma.monitorMatch.deleteMany({});
      await prisma.monitorRecord.deleteMany({});
      await prisma.monitorRule.deleteMany({});
      await prisma.appUserAccess.deleteMany({ where: { username: authUsername } });
      await prisma.appUser.deleteMany({ where: { username: authUsername } });
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
      console.warn(
        'monitor.e2e-spec.ts: all subsequent cases are NO-OPS because no live Postgres was reachable.',
      );
    }
    expect(true).toBe(true);
  });

  const DEFAULT_ORDER = ['R8', 'R4', 'R5', 'R2', 'R1', 'R9', 'R10', 'R3', 'R6', 'R11', 'R12', 'R7'];

  async function listedIds(query: Record<string, string> = {}): Promise<string[]> {
    const res = await agent.get('/api/monitor/exams').query(query).expect(200);
    return res.body.items.map((item: { recordId: string }) => item.recordId);
  }

  async function assertSummaryMatchesList(query: Record<string, string>): Promise<void> {
    const [listRes, sumRes] = await Promise.all([
      agent.get('/api/monitor/exams').query(query).expect(200),
      agent.get('/api/monitor/summary').query(query).expect(200),
    ]);
    const sum = sumRes.body;
    expect(sum.total).toBe(listRes.body.total);
    expect(sum.red + sum.yellow + sum.green + sum.unclassified).toBe(sum.total);
  }

  // --- List shape ------------------------------------------------------

  itWithDb(
    'returns all 12 fixture rows with exactly the list fields (no report body, no status)',
    async () => {
      const res = await agent.get('/api/monitor/exams').expect(200);
      expect(res.body.total).toBe(12);
      expect(res.body.page).toBe(1);
      expect(res.body.pageSize).toBe(20);
      expect(res.body.items).toHaveLength(12);

      const item = res.body.items[0];
      for (const field of [
        'recordId',
        'monitorLevel',
        'patientName',
        'department',
        'bedNo',
        'patientType',
        'examItem',
        'examDate',
        'examTime',
        'matchedKeywords',
      ]) {
        expect(item).toHaveProperty(field);
      }
      // Read-only display contract: the report body and any disposition
      // status must never appear in a list row.
      for (const forbidden of ['reportContent', 'diagnosis', 'reportStatus', 'handlingStatus']) {
        expect(Object.prototype.hasOwnProperty.call(item, forbidden)).toBe(false);
      }
    },
  );

  itWithDb(
    'default sort is examTime desc with the RED>YELLOW>GREEN>UNCLASSIFIED tie-break and nulls last',
    async () => {
      const idsInOrder = await listedIds();
      expect(idsInOrder).toEqual(DEFAULT_ORDER.map((key) => ids[key]));
    },
  );

  // --- Filters ---------------------------------------------------------

  itWithDb(
    'filters by a single Shanghai day across the UTC date boundary (from=to=2026-08-20)',
    async () => {
      const res = await agent
        .get('/api/monitor/exams')
        .query({ examDateFrom: '2026-08-20', examDateTo: '2026-08-20' })
        .expect(200);
      const got = new Set(res.body.items.map((item: { recordId: string }) => item.recordId));
      expect(res.body.total).toBe(8);
      // R3 is stored at UTC 08-19 but displays/filters as Shanghai 08-20.
      expect(got.has(ids.R3)).toBe(true);
      for (const key of ['R1', 'R2', 'R4', 'R5', 'R8', 'R9', 'R10'])
        expect(got.has(ids[key])).toBe(true);
      // Records on other Shanghai days / null examTime are excluded.
      for (const key of ['R6', 'R11', 'R12', 'R7']) expect(got.has(ids[key])).toBe(false);
    },
  );

  itWithDb('treats examDateTo as an exclusive upper bound at the next-day boundary', async () => {
    // examDateTo includes all of the named Shanghai day. R11 sits exactly
    // at 08-18 00:00 - the boundary of the day AFTER 08-17 - so a
    // through-08-17 query must exclude it, leaving only R12 (08-17 23:59).
    const res = await agent
      .get('/api/monitor/exams')
      .query({ examDateTo: '2026-08-17' })
      .expect(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].recordId).toBe(ids.R12);
  });

  itWithDb('supports open-ended date bounds', async () => {
    // Through end of 08-20 = every record with a non-null examTime (11).
    const to = await agent
      .get('/api/monitor/exams')
      .query({ examDateTo: '2026-08-20' })
      .expect(200);
    expect(to.body.total).toBe(11);
    // Through end of 08-18 = R12 (08-17 23:59) + R11 (08-18 00:00).
    const to18 = await agent
      .get('/api/monitor/exams')
      .query({ examDateTo: '2026-08-18' })
      .expect(200);
    expect(to18.body.total).toBe(2);
    // From start of 08-19 = the 8 records on 08-20 + R6 (08-19 20:00).
    const from = await agent
      .get('/api/monitor/exams')
      .query({ examDateFrom: '2026-08-19' })
      .expect(200);
    expect(from.body.total).toBe(9);
  });

  itWithDb('filters by department (case-insensitive exact match)', async () => {
    const res = await agent.get('/api/monitor/exams').query({ department: '消化内科' }).expect(200);
    expect(res.body.total).toBe(7);
    const res2 = await agent
      .get('/api/monitor/exams')
      .query({ department: '呼吸内科' })
      .expect(200);
    expect(res2.body.total).toBe(3);
  });

  itWithDb('filters by patientTypeCode exact match', async () => {
    const res = await agent.get('/api/monitor/exams').query({ patientTypeCode: 'I' }).expect(200);
    expect(res.body.total).toBe(5);
    const unknown = await agent
      .get('/api/monitor/exams')
      .query({ patientTypeCode: 'X' })
      .expect(200);
    expect(unknown.body.total).toBe(1);
    expect(unknown.body.items[0].recordId).toBe(ids.R12);
  });

  itWithDb('filters by attention level', async () => {
    const red = await agent.get('/api/monitor/exams').query({ level: 'RED' }).expect(200);
    expect(red.body.total).toBe(3);
    const unclassified = await agent
      .get('/api/monitor/exams')
      .query({ level: 'UNCLASSIFIED' })
      .expect(200);
    expect(unclassified.body.total).toBe(2);
  });

  itWithDb('filters by examItem substring (case-insensitive)', async () => {
    const res = await agent.get('/api/monitor/exams').query({ examItem: '电子胃镜' }).expect(200);
    expect(res.body.total).toBe(7);
    const res2 = await agent.get('/api/monitor/exams').query({ examItem: '支气管镜' }).expect(200);
    expect(res2.body.total).toBe(3);
  });

  itWithDb('patientName searches patientName only - never report text', async () => {
    const byName = await agent
      .get('/api/monitor/exams')
      .query({ patientName: '测试患者' })
      .expect(200);
    expect(byName.body.total).toBe(11); // all except R7 (null patientName)
    expect(byName.body.items.some((item: { recordId: string }) => item.recordId === ids.R7)).toBe(
      false,
    );

    const byNameExact = await agent
      .get('/api/monitor/exams')
      .query({ patientName: '患者子' })
      .expect(200);
    expect(byNameExact.body.total).toBe(1);
    expect(byNameExact.body.items[0].recordId).toBe(ids.R12);
  });

  itWithDb('keyword matches the exact matched-rule keyword only - never report text', async () => {
    // keyword='腺癌' finds R1/R8/R9 via their matched keyword, but NOT R12
    // whose report body mentions 腺癌 yet has no rule hit - proving keyword
    // does not scan reportContent/diagnosis, and matches the exact keyword
    // rather than a substring.
    const byKeyword = await agent
      .get('/api/monitor/exams')
      .query({ keyword: '腺癌' })
      .expect(200);
    expect(byKeyword.body.total).toBe(3);
    expect(
      byKeyword.body.items.some((item: { recordId: string }) => item.recordId === ids.R12),
    ).toBe(false);

    const byKeyword2 = await agent
      .get('/api/monitor/exams')
      .query({ keyword: '息肉样' })
      .expect(200);
    expect(byKeyword2.body.total).toBe(5);
  });

  itWithDb('combines filters (AND semantics)', async () => {
    const res = await agent
      .get('/api/monitor/exams')
      .query({ department: '消化内科', level: 'YELLOW' })
      .expect(200);
    expect(res.body.total).toBe(3); // R2, R4, R5

    const res2 = await agent
      .get('/api/monitor/exams')
      .query({ patientTypeCode: 'I', examItem: '电子胃镜' })
      .expect(200);
    expect(res2.body.total).toBe(5);

    const res3 = await agent
      .get('/api/monitor/exams')
      .query({ examDateFrom: '2026-08-20', examDateTo: '2026-08-20', level: 'YELLOW' })
      .expect(200);
    expect(res3.body.total).toBe(4); // R2, R4, R5, R10
  });

  itWithDb('returns an empty result set for a filter combination with no matches', async () => {
    const res = await agent
      .get('/api/monitor/exams')
      .query({ level: 'GREEN', keyword: '息肉样' })
      .expect(200);
    expect(res.body.total).toBe(0);
    expect(res.body.items).toHaveLength(0);
  });

  // --- Null rows -------------------------------------------------------

  itWithDb('surfaces the fully-null row R7 with null display values', async () => {
    const res = await agent.get('/api/monitor/exams').query({ level: 'UNCLASSIFIED' }).expect(200);
    const r7 = res.body.items.find((item: { recordId: string }) => item.recordId === ids.R7);
    expect(r7).toBeDefined();
    expect(r7.monitorLevel).toBe('UNCLASSIFIED');
    expect(r7.patientName).toBeNull();
    expect(r7.department).toBeNull();
    expect(r7.bedNo).toBeNull();
    expect(r7.patientType).toEqual({ code: null, name: null });
    expect(r7.examItem).toBeNull();
    expect(r7.examDate).toBeNull();
    expect(r7.examTime).toBeNull();
    expect(r7.matchedKeywords).toEqual([]);
  });

  itWithDb(
    'formats examDate/examTime in Asia/Shanghai (incl. midnight 00:00:00, not 24:00:00)',
    async () => {
      const res = await agent
        .get('/api/monitor/exams')
        .query({ patientName: '患者癸' })
        .expect(200);
      const r11 = res.body.items[0];
      expect(r11.examDate).toBe('2026-08-18');
      expect(r11.examTime).toBe('00:00:00');
    },
  );

  // --- Pagination ------------------------------------------------------

  itWithDb(
    'paginates stably (concatenated pages == full default order, no gap/overlap)',
    async () => {
      const full = await listedIds();
      const pageSize = 4;
      let concatenated: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await agent.get('/api/monitor/exams').query({ page, pageSize }).expect(200);
        concatenated = concatenated.concat(
          res.body.items.map((item: { recordId: string }) => item.recordId),
        );
      }
      expect(concatenated).toEqual(full);

      const page4 = await agent
        .get('/api/monitor/exams')
        .query({ page: 4, pageSize: 4 })
        .expect(200);
      expect(page4.body.items).toHaveLength(0);
      expect(page4.body.total).toBe(12);
    },
  );

  // --- Sorting ---------------------------------------------------------

  itWithDb('applies sortBy/sortDir (custom columns sort per Postgres null defaults)', async () => {
    // examTime asc: nulls last (explicit), then ascending by time.
    const asc = await agent
      .get('/api/monitor/exams')
      .query({ sortBy: 'examTime', sortDir: 'asc' })
      .expect(200);
    expect(asc.body.items[0].recordId).toBe(ids.R12);
    expect(asc.body.items[10].recordId).toBe(ids.R8);
    expect(asc.body.items[11].recordId).toBe(ids.R7);

    // Custom sort columns use Postgres defaults: nulls LAST for asc,
    // nulls FIRST for desc (only examTime gets the explicit nulls:'last').
    const nameAsc = await agent
      .get('/api/monitor/exams')
      .query({ sortBy: 'patientName', sortDir: 'asc' })
      .expect(200);
    expect(nameAsc.body.items[11].recordId).toBe(ids.R7);
    const nameDesc = await agent
      .get('/api/monitor/exams')
      .query({ sortBy: 'patientName', sortDir: 'desc' })
      .expect(200);
    expect(nameDesc.body.items[0].recordId).toBe(ids.R7);
  });

  itWithDb('rejects invalid params with 400', async () => {
    const cases = [
      { sortBy: 'notAField' },
      { sortDir: 'sideways' },
      { level: 'BLUE' },
      { examDateFrom: '2026/08/20' },
      { examDateTo: '20-08-2026' },
    ];
    for (const query of cases) {
      await agent.get('/api/monitor/exams').query(query).expect(400);
    }
    const impossible = await agent
      .get('/api/monitor/exams')
      .query({ examDateFrom: '2026-02-31' })
      .expect(400);
    expect(impossible.body.error.code).toBe('INVALID_DATE_PARAM');
  });

  // --- Summary ---------------------------------------------------------

  itWithDb('summary matches the list under the same filters (empty query)', async () => {
    const [listRes, sumRes] = await Promise.all([
      agent.get('/api/monitor/exams').expect(200),
      agent.get('/api/monitor/summary').expect(200),
    ]);
    expect(listRes.body.total).toBe(12);
    expect(sumRes.body).toEqual({ total: 12, red: 3, yellow: 4, green: 3, unclassified: 2 });
  });

  itWithDb('summary reflects every applied filter', async () => {
    await assertSummaryMatchesList({ level: 'RED' });
    await assertSummaryMatchesList({ department: '呼吸内科' });
    await assertSummaryMatchesList({ keyword: '息肉样', level: 'YELLOW' });
    await assertSummaryMatchesList({ examDateFrom: '2026-08-20', examDateTo: '2026-08-20' });
  });

  itWithDb('summary level=RED counts only red records', async () => {
    const res = await agent.get('/api/monitor/summary').query({ level: 'RED' }).expect(200);
    expect(res.body).toEqual({ total: 3, red: 3, yellow: 0, green: 0, unclassified: 0 });
  });

  // --- Detail ----------------------------------------------------------

  itWithDb('detail returns the full snapshot + all hits (multi-keyword R1)', async () => {
    const res = await agent.get(`/api/monitor/exams/${ids.R1}`).expect(200);
    expect(res.body.recordId).toBe(ids.R1);
    expect(res.body.monitorLevel).toBe('RED');
    expect(res.body.reportContent).toBe('胃窦见一处隆起性病变，病理提示黏膜内腺癌。');
    expect(res.body.diagnosis).toBe('胃腺癌（早期）。');
    expect(res.body.hits).toHaveLength(2);
    expect(res.body.hits[0]).toEqual({
      ruleId: ruleIds['rule-1'],
      ruleVersion: 1,
      keyword: '腺癌',
      level: 'RED',
      matchedField: 'REPORT_TEXT',
      contextSnippet: '…黏膜内腺癌…',
      matchedAt: '2026-08-20T08:15:30.000Z',
    });
    expect(res.body.hits[1]).toEqual(
      expect.objectContaining({
        ruleId: ruleIds['rule-4'],
        ruleVersion: 1,
        keyword: '息肉样',
        matchedField: 'FINDINGS',
      }),
    );
    expect(res.body.matchedKeywords).toEqual(['腺癌', '息肉样']);
  });

  itWithDb('detail dedupes keywords that matched via multiple rules (R9)', async () => {
    const res = await agent.get(`/api/monitor/exams/${ids.R9}`).expect(200);
    expect(res.body.hits).toHaveLength(2);
    expect(res.body.matchedKeywords).toEqual(['腺癌']);
  });

  itWithDb('detail of an unclassified record has empty hits and no body', async () => {
    const res = await agent.get(`/api/monitor/exams/${ids.R7}`).expect(200);
    expect(res.body.monitorLevel).toBe('UNCLASSIFIED');
    expect(res.body.hits).toEqual([]);
    expect(res.body.reportContent).toBeNull();
    expect(res.body.diagnosis).toBeNull();
  });

  // Issue #8: every hit is locatable to the exact report field it matched -
  // matchedField maps FINDINGS/IMPRESSION to 报告内容/诊断 (see
  // docs/api/monitor-api.md). R1's 腺癌 hit came from the REPORT_TEXT rule
  // (报告内容), R8's 浸润癌 hit from the IMPRESSION rule (诊断).
  itWithDb(
    'detail locates each hit to the report field it matched (report vs diagnosis)',
    async () => {
      const r1 = await agent.get(`/api/monitor/exams/${ids.R1}`).expect(200);
      const adenoca = r1.body.hits.find((h: { keyword: string }) => h.keyword === '腺癌');
      expect(adenoca).toEqual(
        expect.objectContaining({
          ruleId: ruleIds['rule-1'],
          ruleVersion: 1,
          matchedField: 'REPORT_TEXT',
        }),
      );
      expect(adenoca.matchedField).toBe('REPORT_TEXT'); // → 命中在 报告内容

      const r8 = await agent.get(`/api/monitor/exams/${ids.R8}`).expect(200);
      const infiltrating = r8.body.hits.find((h: { keyword: string }) => h.keyword === '浸润癌');
      expect(infiltrating).toEqual(
        expect.objectContaining({
          ruleId: ruleIds['rule-3'],
          ruleVersion: 1,
          matchedField: 'IMPRESSION', // → 命中在 诊断
        }),
      );
    },
  );

  // Issue #8 test requirement: 空诊断 - report body present, diagnosis null.
  itWithDb('detail of a record with an empty diagnosis keeps the report body', async () => {
    const res = await agent.get(`/api/monitor/exams/${ids.R2}`).expect(200);
    expect(res.body.diagnosis).toBeNull();
    expect(res.body.reportContent).toBe('胃体见多发息肉样隆起。');
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0]).toEqual(
      expect.objectContaining({
        ruleId: ruleIds['rule-4'],
        ruleVersion: 1,
        keyword: '息肉样',
      }),
    );
  });

  // 角色、科室范围、脱敏与审计由 issue #13 负责；本套件仅使用基础登录会话。
  itWithDb('detail returns 404 MONITOR_RECORD_NOT_FOUND for an unknown id', async () => {
    const res = await agent
      .get('/api/monitor/exams/00000000-0000-0000-0000-000000000000')
      .expect(404);
    expect(res.body.error.code).toBe('MONITOR_RECORD_NOT_FOUND');
  });
});
