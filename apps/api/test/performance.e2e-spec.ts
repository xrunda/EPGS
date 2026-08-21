import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient, MonitorLevel } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';

// The 100k-row seed + ANALYZE + HTTP warm-up round-trips take well past Jest's
// default 5s hook timeout; this suite is explicitly a long-running benchmark.
jest.setTimeout(180_000);

/**
 * Issue #14 acceptance: "常用筛选目标响应时间不超过 3 秒". Proves the
 * workbench's common filters hold the 3s target on a realistic 100,000-row
 * dataset (roughly 1-2 years of an endoscopy center). It boots the real
 * AppModule, seeds monitor_record + monitor_match + rules + an authenticated
 * VIEWER, ANALYZEs so the planner actually uses indexes, then measures
 * wall-clock HTTP round-trips through the full stack (JWT guard, RolesGuard,
 * masking, audit write, query) for each representative filter.
 *
 * Same itWithDb no-op-on-unreachable-DB pattern as the other suites, so the
 * DB-free CI job stays untouched; runs for real in the db-migrations job
 * (where it is ordered right before the seed-count step). afterAll wipes
 * audit_log -> app_user_access -> app_user -> monitor_match -> monitor_record
 * -> monitor_rule so the seed-count step still sees exactly 6 RED rules.
 *
 * Indexed vs non-indexed is honest: level/department/exam_time/patientType
 * are index-assisted (patientType gained its btree index in this same issue),
 * while examItem and q are substring searches (ILIKE '%..%') that cannot use
 * a btree index - they are still well under the target at this volume, and a
 * pg_trgm index is the documented follow-up if volume grows much further.
 */
describe('Performance (e2e, real Postgres): common filters ≤ 3s at 100k rows', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  const PASSWORD = 'perf-e2e-password';
  const USERNAME = 'perf-e2e-viewer';

  const ROW_COUNT = 100_000;
  const CHUNK = 2_000;
  const DAY_MS = 86_400_000;
  const MIN_MS = 60_000;
  const TARGET_MS = 3_000;

  const DEPARTMENTS = [
    '消化内科',
    '呼吸内科',
    '普外科',
    '心内科',
    '神经内科',
    '骨科',
    '内分泌科',
    '泌尿外科',
  ];
  const LEVELS = ['RED', 'YELLOW', 'GREEN', 'UNCLASSIFIED'] as const;
  const EXAM_ITEMS = [
    '电子胃镜检查',
    '电子结肠镜检查',
    '电子支气管镜检查',
    '电子十二指肠镜检查',
    '胶囊内镜检查',
  ];
  const RULE_KEYWORDS = ['腺癌早期', '息肉样', '胃镜', '食管裂孔疝', '贲门失弛缓症', '肿瘤'];

  let agent: ReturnType<typeof request.agent>;
  // Mutated in place by seedDataset; `const` is correct (never reassigned).
  const ruleIds: string[] = [];

  function shanghaiDateAgo(daysAgo: number): string {
    return new Date(Date.now() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  }

  async function seedDataset(): Promise<void> {
    const now = Date.now();

    // 6 rules so monitor_match rows reference real rule versions.
    for (const keyword of RULE_KEYWORDS) {
      const id = randomUUID();
      const rule = await prisma.monitorRule.create({
        data: {
          id,
          keyword,
          level: keyword === '息肉样' ? ('YELLOW' as never) : ('RED' as never),
          matchField: 'REPORT_TEXT' as never,
          ruleGroupId: id,
          createdBy: 'perf-e2e',
          updatedBy: 'perf-e2e',
        },
      });
      ruleIds.push(rule.id);
    }

    // 100k monitor_record rows: 8 departments x 4 levels x ~18 months of
    // exam_time x patientType I/O x 5 exam items. every 20th row is named
    // 张三丰 (q=张三 matches ~5k), every 10th row carries a lastMatchedAt so
    // it later gets a monitor_match row.
    for (let offset = 0; offset < ROW_COUNT; offset += CHUNK) {
      const rows: Array<{
        sourceRecordId: string;
        reportId: string;
        reportVersion: number;
        sourceUpdatedAt: Date;
        patientName: string;
        department: string;
        bedNo: string;
        patientTypeCode: string;
        patientTypeName: string;
        examItem: string;
        examTime: Date;
        currentLevel: MonitorLevel;
        firstMatchedAt: Date | null;
        lastMatchedAt: Date | null;
        reportContent: string;
        diagnosis: string;
      }> = [];
      for (let k = offset; k < Math.min(offset + CHUNK, ROW_COUNT); k += 1) {
        const g = k + 1; // 1-based row id
        const matched = g % 10 === 0;
        const examOffset = (g % 540) * DAY_MS + (g % 1440) * MIN_MS;
        rows.push({
          sourceRecordId: `PERF-${g}`,
          reportId: `PERF-${g}`,
          reportVersion: 1,
          sourceUpdatedAt: new Date(now - examOffset),
          patientName: g % 20 === 0 ? '张三丰' : `患者${g % 9999}`,
          department: DEPARTMENTS[g % DEPARTMENTS.length],
          bedNo: `${1 + (g % 40)}-${1 + (g % 12)}`,
          patientTypeCode: g % 2 === 0 ? 'I' : 'O',
          patientTypeName: g % 2 === 0 ? '住院' : '门诊',
          examItem: EXAM_ITEMS[g % EXAM_ITEMS.length],
          examTime: new Date(now - examOffset),
          currentLevel: LEVELS[g % LEVELS.length],
          firstMatchedAt: matched ? new Date(now - examOffset) : null,
          lastMatchedAt: matched ? new Date(now - examOffset) : null,
          reportContent: `内镜所见描述文本 ${g}`,
          diagnosis: `诊断意见文本 ${g}`,
        });
      }
      await prisma.monitorRecord.createMany({ data: rows });
    }

    // monitor_match for every 10th record (10k rows) - exercises the q
    // filter's correlated `matches.some.keyword` subquery and the detail
    // endpoint's include-hits path.
    const matchedIds = await prisma.monitorRecord.findMany({
      where: { lastMatchedAt: { not: null } },
      select: { id: true },
    });
    for (let i = 0; i < matchedIds.length; i += CHUNK) {
      const slice = matchedIds.slice(i, i + CHUNK);
      await prisma.monitorMatch.createMany({
        data: slice.map(({ id }, j) => {
          const idx = (i + j) % RULE_KEYWORDS.length;
          return {
            monitorRecordId: id,
            ruleId: ruleIds[idx],
            keyword: RULE_KEYWORDS[idx],
            level: (RULE_KEYWORDS[idx] === '息肉样' ? 'YELLOW' : 'RED') as never,
            matchedField: 'REPORT_TEXT' as never,
            contextSnippet: `…${RULE_KEYWORDS[idx]}…`,
            reportVersion: 1,
            matchedAt: new Date(),
          };
        }),
      });
    }

    // Fresh statistics so the planner picks the btree indexes on this now
    // large table instead of defaulting to a seq scan.
    await prisma.$executeRawUnsafe('ANALYZE monitor_record;');
    await prisma.$executeRawUnsafe('ANALYZE monitor_match;');
  }

  async function measure(label: string, url: string): Promise<number> {
    // Warm up once so caches/JIT/buffer-pool effects don't count against the
    // very first request, then measure the real round-trip. A benchmark must
    // not fail on a transient keep-alive socket reset (observed once on a
    // freshly-booted server), so a burst of back-to-back requests retries once.
    const get = async (): Promise<number> => {
      try {
        const t0 = performance.now();
        await agent.get(url).expect(200);
        return performance.now() - t0;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ECONNRESET') {
          // eslint-disable-next-line no-console
          console.warn(`  PERF  ${label}: transient ECONNRESET, retrying once`);
          const t0 = performance.now();
          await agent.get(url).expect(200);
          return performance.now() - t0;
        }
        throw err;
      }
    };
    await get(); // warm-up
    const ms = await get(); // measured
    // eslint-disable-next-line no-console
    console.log(`  PERF  ${label}: ${ms.toFixed(1)}ms (target < ${TARGET_MS}ms)`);
    expect(ms).toBeLessThan(TARGET_MS);
    return ms;
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
        `Skipping performance e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}).`,
      );
      return;
    }

    // Self-contained: wipe every table this suite seeds, so a local re-run or
    // residue from earlier suites never shifts the seed-count step (which runs
    // strictly after this suite's afterAll in CI).
    await prisma.auditLog.deleteMany({});
    await prisma.appUserAccess.deleteMany({});
    await prisma.appUser.deleteMany({});
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    await prisma.monitorRule.deleteMany({});

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

    await prisma.appUser.create({
      data: {
        username: USERNAME,
        displayName: '性能验收查看者',
        passwordHash: await hash(PASSWORD, { type: argon2id }),
      },
    });
    await prisma.appUserAccess.create({
      data: {
        username: USERNAME,
        roles: ['VIEWER'] as never,
        departmentScope: [],
        patientDetail: true,
      },
    });

    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ username: USERNAME, password: PASSWORD })
      .expect(200);

    // eslint-disable-next-line no-console
    console.log(`Seeding ${ROW_COUNT} monitor_record rows + 10k matches ...`);
    const seedStart = performance.now();
    await seedDataset();
    // eslint-disable-next-line no-console
    console.log(`Seeded in ${((performance.now() - seedStart) / 1000).toFixed(1)}s`);
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
      console.warn('performance.e2e-spec.ts: all subsequent cases are NO-OPS (no live Postgres).');
    }
    expect(true).toBe(true);
  });

  itWithDb('list + summary common filters stay under the 3s target on 100k rows', async () => {
    const list = '/api/monitor/exams';
    const from = shanghaiDateAgo(30);
    const to = shanghaiDateAgo(0);

    await measure(
      'list level=RED + department (indexed)',
      `${list}?level=RED&department=${encodeURIComponent('消化内科')}`,
    );
    await measure(
      'list date range (exam_time index)',
      `${list}?examDateFrom=${from}&examDateTo=${to}`,
    );
    await measure('list patientTypeCode=I (indexed, issue #14)', `${list}?patientTypeCode=I`);
    await measure(
      'list examItem substring (unindexed seq scan)',
      `${list}?examItem=${encodeURIComponent('胃镜')}`,
    );
    await measure('list q=张三 patientName substring', `${list}?q=${encodeURIComponent('张三')}`);
    await measure(
      'list q=胃镜 matched-keyword correlated subquery',
      `${list}?q=${encodeURIComponent('胃镜')}`,
    );
    await measure(
      'summary department (GROUP BY indexed level)',
      `/api/monitor/summary?department=${encodeURIComponent('消化内科')}`,
    );
  });

  itWithDb('detail by primary key (with hits) stays under the 3s target', async () => {
    const matched = await prisma.monitorRecord.findFirst({
      where: { lastMatchedAt: { not: null } },
    });
    expect(matched).not.toBeNull();
    await measure('detail by id incl. hits', `/api/monitor/exams/${matched!.id}`);
  });

  itWithDb('the patient_type_code index added in issue #14 actually exists', async () => {
    // Deterministic catalog proof (stronger than a planner-heuristic EXPLAIN:
    // with only I/O values ~50% of rows match, the planner is right to seq
    // scan, so an EXPLAIN would not show the index even though it is present
    // and fast enough at this volume). A missing index - i.e. the migration
    // never applied - fails loudly here instead of silently.
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'monitor_record'
        AND indexname = 'monitor_record_patient_type_code_idx'
    `;
    expect(rows.length).toBe(1);
  });
});
