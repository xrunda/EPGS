import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import {
  MonitorExamWorkbenchDetailDto,
  MonitorLevelConflictListDto,
} from '@epgs/shared-types';
import { hash, argon2id } from 'argon2';

/**
 * Issue #103 e2e: level conflicts, against a REAL Postgres.
 *
 * What this suite exists to prove, in the order it would hurt to get wrong:
 *
 *  1. THE TWO SURFACES AGREE. The doctor's notice and the admin's todo are the
 *     same computation over the same rows - this suite reads the doctor's
 *     `levelConflicts` and the admin's list on the SAME seeded record and
 *     asserts they describe the same disagreement. A second implementation of
 *     the rule would pass either half alone and fail here.
 *  2. THE READ STATE SURVIVES, and both writes are idempotent. Marking read
 *     twice is not an error and does not create a second row; marking an
 *     unknown conflict unread succeeds, because the requested state holds.
 *  3. THE LIST IS DERIVED, NOT STORED. Nothing about a conflict except the read
 *     flag is persisted, so the recordCount is recomputed per request - asserted
 *     by counting the seeded records, and by the same conflict's count changing
 *     when the window changes.
 *  4. NO PATIENT DATA crosses this wire. The list carries two group ids' worth of
 *     configuration metadata, a keyword, a semantic name and two levels - never
 *     a report body, a patient name or a record id.
 *  5. RULE_ADMIN ONLY, on the reads as well as the writes, and both writes leave
 *     an audit row naming the actor.
 *
 * CRITICAL for CI: this suite seeds its own rules, semantics and records and
 * wipes monitor_match -> monitor_record -> monitor_rule in beforeAll AND
 * afterAll (plus its own read rows, semantics and users), so the later
 * seed-count step still sees exactly the 17 seeded RED rules. Its keywords are
 * disjoint from prisma/seed.ts's.
 */
describe('Level conflicts (e2e, real Postgres) - issue #103', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let agent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;

  const authUsername = 'level-conflict-e2e-admin';
  const viewerUsername = 'level-conflict-e2e-viewer';
  const authPassword = 'synthetic-level-conflict-password';
  const DEPARTMENT = '等级分歧E2E科室';

  /**
   * The report every conflict fixture is built on. Offsets below are UTF-16
   * into THIS string, untrimmed, as the matcher and the classifier both store
   * them: 3..10 = 巨大不规则隆起, 16..18 = 质脆.
   */
  const REPORT = '胃体见巨大不规则隆起，表面糜烂，质脆。';
  const OVERLAP_TEXT = REPORT.slice(3, 10);
  const FRAIL_TEXT = REPORT.slice(16, 18);

  const RULE_A_GROUP = '00000000-0000-4000-8000-00000000c101';
  const RULE_B_GROUP = '00000000-0000-4000-8000-00000000c102';
  const RULE_C_GROUP = '00000000-0000-4000-8000-00000000c103';
  const SEMANTIC_RED_GROUP = '00000000-0000-4000-8000-00000000c201';
  const SEMANTIC_YELLOW_GROUP = '00000000-0000-4000-8000-00000000c202';

  const KEY_MAIN = [RULE_A_GROUP, SEMANTIC_RED_GROUP, 'FINDINGS', 'YELLOW', 'RED'].join(':');
  const KEY_OLD = [RULE_B_GROUP, SEMANTIC_YELLOW_GROUP, 'FINDINGS', 'RED', 'YELLOW'].join(':');

  const DAY_MS = 24 * 60 * 60 * 1000;
  /** Inside every window this suite asks for. */
  const RECENT = new Date(Date.now() - 2 * DAY_MS);
  /** Inside `days=90`, outside `days=7` - the window's two-sided proof. */
  const FORTY_DAYS_AGO = new Date(Date.now() - 40 * DAY_MS);
  const RESOLVED_AT = new Date(Date.now() - 2 * DAY_MS + 5000);

  const ids: Record<string, string> = {};
  const semanticIds: string[] = [];

  function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  interface Fixture {
    key: string;
    patientName: string;
    ruleId: string;
    keyword: string;
    hitLevel: 'RED' | 'YELLOW';
    hitStart: number;
    hitEnd: number;
    /** The single AI finding's level and evidence range. */
    aiLevel: 'RED' | 'YELLOW';
    semanticId: string;
    semanticName: string;
    evidenceStart: number;
    evidenceEnd: number;
    lastMatchedAt: Date;
  }

  let fixtures: Fixture[] = [];

  async function seed(): Promise<void> {
    await wipe();

    const ruleIds: Record<string, string> = {};
    for (const [group, keyword] of [
      [RULE_A_GROUP, OVERLAP_TEXT],
      [RULE_B_GROUP, FRAIL_TEXT],
      [RULE_C_GROUP, FRAIL_TEXT],
    ] as const) {
      const rule = await prisma.monitorRule.create({
        data: {
          ruleGroupId: group,
          keyword,
          // YELLOW on purpose: the 17-enabled-RED assertion downstream must not
          // be able to see these rules even if a crashed run left them behind.
          level: 'YELLOW',
          matchField: 'REPORT_TEXT',
          isEnabled: true,
          version: 1,
          createdBy: authUsername,
          updatedBy: authUsername,
        },
      });
      ruleIds[group] = rule.id;
    }

    const semantics: Record<string, { id: string; name: string; level: 'RED' | 'YELLOW' }> = {};
    for (const [group, name, level] of [
      [SEMANTIC_RED_GROUP, '明确或高度疑似恶性病变', 'RED'],
      [SEMANTIC_YELLOW_GROUP, '性质待定、需活检的病变', 'YELLOW'],
    ] as const) {
      const semantic = await prisma.attentionSemantic.create({
        data: {
          semanticGroupId: group,
          name,
          description: '等级分歧 e2e 合成条目。',
          attentionLevel: level,
          isEnabled: true,
          version: 1,
          createdBy: authUsername,
          updatedBy: authUsername,
        },
      });
      semanticIds.push(semantic.id);
      semantics[group] = { id: semantic.id, name, level };
    }

    fixtures = [
      // The main conflict: keyword YELLOW and AI RED on the same span.
      {
        key: 'main1',
        patientName: '合成分歧甲',
        ruleId: ruleIds[RULE_A_GROUP],
        keyword: OVERLAP_TEXT,
        hitLevel: 'YELLOW',
        hitStart: 3,
        hitEnd: 10,
        aiLevel: 'RED',
        semanticId: semantics[SEMANTIC_RED_GROUP].id,
        semanticName: semantics[SEMANTIC_RED_GROUP].name,
        evidenceStart: 0,
        evidenceEnd: 12,
        lastMatchedAt: RECENT,
      },
      // A second record with the same configuration - the aggregation's count.
      {
        key: 'main2',
        patientName: '合成分歧乙',
        ruleId: ruleIds[RULE_A_GROUP],
        keyword: OVERLAP_TEXT,
        hitLevel: 'YELLOW',
        hitStart: 3,
        hitEnd: 10,
        aiLevel: 'RED',
        semanticId: semantics[SEMANTIC_RED_GROUP].id,
        semanticName: semantics[SEMANTIC_RED_GROUP].name,
        evidenceStart: 0,
        evidenceEnd: 12,
        lastMatchedAt: RECENT,
      },
      // Same place, SAME level. Nothing to reconcile, nothing to show.
      {
        key: 'agree',
        patientName: '合成一致丙',
        ruleId: ruleIds[RULE_C_GROUP],
        keyword: FRAIL_TEXT,
        hitLevel: 'RED',
        hitStart: 16,
        hitEnd: 18,
        aiLevel: 'RED',
        semanticId: semantics[SEMANTIC_RED_GROUP].id,
        semanticName: semantics[SEMANTIC_RED_GROUP].name,
        evidenceStart: 16,
        evidenceEnd: 18,
        lastMatchedAt: RECENT,
      },
      // A real conflict, but a stale one: outside days=7, inside days=90.
      {
        key: 'old',
        patientName: '合成陈旧丁',
        ruleId: ruleIds[RULE_B_GROUP],
        keyword: FRAIL_TEXT,
        hitLevel: 'RED',
        hitStart: 16,
        hitEnd: 18,
        aiLevel: 'YELLOW',
        semanticId: semantics[SEMANTIC_YELLOW_GROUP].id,
        semanticName: semantics[SEMANTIC_YELLOW_GROUP].name,
        evidenceStart: 16,
        evidenceEnd: 18,
        lastMatchedAt: FORTY_DAYS_AGO,
      },
    ];

    for (const fixture of fixtures) {
      const record = await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `e2e-lc-${fixture.key}`,
          reportId: `e2e-lc-report-${fixture.key}`,
          reportVersion: 1,
          patientName: fixture.patientName,
          department: DEPARTMENT,
          bedNo: '3-3',
          patientTypeCode: 'I',
          patientTypeName: '住院',
          examItem: '电子胃镜检查',
          examTime: RECENT,
          sourceUpdatedAt: RECENT,
          // MAX(keyword RED/YELLOW, AI level) - what the worker's recompute
          // would have denormalized for these inputs.
          currentLevel: 'RED',
          reportContent: REPORT,
          diagnosis: null,
          aiAttentionLevel: fixture.aiLevel,
          aiResolvedAt: RESOLVED_AT,
          lastMatchedAt: fixture.lastMatchedAt,
        },
      });
      ids[fixture.key] = record.id;

      await prisma.monitorMatch.create({
        data: {
          monitorRecordId: record.id,
          ruleId: fixture.ruleId,
          keyword: fixture.keyword,
          level: fixture.hitLevel,
          matchedField: 'FINDINGS',
          contextSnippet: `…${fixture.keyword}…`,
          matchedAt: fixture.lastMatchedAt,
          reportVersion: 1,
          matchStart: fixture.hitStart,
          matchEnd: fixture.hitEnd,
          semanticFiltered: false,
        },
      });

      const attempt = await prisma.monitorReportAi.create({
        data: {
          monitorRecordId: record.id,
          reportVersion: 1,
          task: 'CLASSIFY_REPORT',
          taskVersion: 'e2e-1',
          outcome: 'OK',
          attentionLevel: fixture.aiLevel,
          modelAttentionLevel: fixture.aiLevel,
          semanticCount: 2,
          matchCount: 1,
          model: 'e2e-synthetic-model',
          inputHash: sha256Hex('e2e-input'),
          reportHash: sha256Hex(REPORT),
          configHash: sha256Hex('e2e-config'),
          latencyMs: 42,
          createdAt: RESOLVED_AT,
        },
      });
      const match = await prisma.monitorReportAiMatch.create({
        data: {
          reportAiId: attempt.id,
          semanticId: fixture.semanticId,
          semanticVersion: 1,
          semanticName: fixture.semanticName,
          attentionLevel: fixture.aiLevel,
          confidence: 'HIGH',
          reason: '合成证据，用于等级分歧 e2e。',
          ordinal: 0,
        },
      });
      await prisma.monitorReportAiEvidence.create({
        data: {
          matchId: match.id,
          ordinal: 0,
          field: 'FINDINGS',
          // The producer hashes the excerpt it located; the interval path does
          // not read the text, but the fallback path does, so the fixture keeps
          // the hash honest either way.
          evidenceHash: sha256Hex(REPORT.slice(fixture.evidenceStart, fixture.evidenceEnd)),
          evidenceStart: fixture.evidenceStart,
          evidenceEnd: fixture.evidenceEnd,
        },
      });
    }
  }

  async function wipe(): Promise<void> {
    // FK order: monitor_report_ai* cascade from monitor_record; monitor_match
    // references monitor_record with Restrict on the rule.
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    await prisma.monitorRule.deleteMany({});
    await prisma.monitorLevelConflictRead.deleteMany({});
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      // The #103 marker table - fails fast if the migration is not applied.
      await prisma.monitorLevelConflictRead.findFirst();
      await prisma.monitorRecord.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping level-conflicts e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite.',
      );
      return;
    }

    await seed();

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

    await prisma.appUserAccess.deleteMany({
      where: { username: { in: [authUsername, viewerUsername] } },
    });
    await prisma.appUser.deleteMany({
      where: { username: { in: [authUsername, viewerUsername] } },
    });
    for (const [username, displayName, roles] of [
      [authUsername, '等级分歧接口测试管理员', ['RULE_ADMIN']],
      [viewerUsername, '等级分歧接口测试只读用户', ['VIEWER']],
    ] as const) {
      await prisma.appUser.create({
        data: {
          username,
          displayName,
          passwordHash: await hash(authPassword, { type: argon2id }),
        },
      });
      await prisma.appUserAccess.create({
        data: {
          username,
          roles: [...roles] as never,
          departmentScope: [],
          patientDetail: true,
        },
      });
    }

    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ username: authUsername, password: authPassword })
      .expect(200);

    viewerAgent = request.agent(app.getHttpServer());
    await viewerAgent
      .post('/api/auth/login')
      .send({ username: viewerUsername, password: authPassword })
      .expect(200);
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.auditLog.deleteMany({});
      await wipe();
      // Restrict FK from monitor_report_ai_match, so these go after the records.
      await prisma.attentionSemantic.deleteMany({ where: { id: { in: semanticIds } } });
      await prisma.appUserAccess.deleteMany({
        where: { username: { in: [authUsername, viewerUsername] } },
      });
      await prisma.appUser.deleteMany({
        where: { username: { in: [authUsername, viewerUsername] } },
      });
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
      console.warn('level-conflicts e2e: DB unavailable, assertions skipped.');
    }
    expect(true).toBe(true);
  });

  async function list(query: Record<string, unknown> = {}): Promise<MonitorLevelConflictListDto> {
    const res = await agent.get('/api/monitor/level-conflicts').query(query).expect(200);
    return res.body as MonitorLevelConflictListDto;
  }

  async function detail(recordId: string): Promise<MonitorExamWorkbenchDetailDto> {
    const res = await agent.get(`/api/monitor/exams/${recordId}`).expect(200);
    return res.body as MonitorExamWorkbenchDetailDto;
  }

  describe('the doctor and the administrator see the same disagreement', () => {
    itWithDb('the drawer names the two sides, and the todo list carries the same ones', async () => {
      const body = await detail(ids.main1);

      expect(body.levelConflicts).toEqual([
        {
          keyword: OVERLAP_TEXT,
          keywordLevel: 'YELLOW',
          semanticName: '明确或高度疑似恶性病变',
          semanticLevel: 'RED',
          field: 'FINDINGS',
        },
      ]);

      // The same record through the admin surface. The admin item is keyed by
      // group ids the doctor's shape does not carry, so the comparison is on
      // the five values both surfaces state - which is exactly the claim: two
      // audiences, one rule.
      const { items } = await list();
      const todo = items.find((item) => item.conflictKey === KEY_MAIN);
      expect(todo).toMatchObject({
        keyword: body.levelConflicts[0].keyword,
        keywordLevel: body.levelConflicts[0].keywordLevel,
        semanticName: body.levelConflicts[0].semanticName,
        semanticLevel: body.levelConflicts[0].semanticLevel,
        field: body.levelConflicts[0].field,
      });
    });

    itWithDb('says nothing when the two sides agree', async () => {
      const body = await detail(ids.agree);

      expect(body.levelConflicts).toEqual([]);
      // Both paths really did find this record - the silence is "they agree",
      // not "nothing ran".
      expect(body.attentionSource).toBe('BOTH');
      expect(body.aiSemantics).toHaveLength(1);
    });
  });

  describe('the todo list', () => {
    itWithDb('folds the records into one entry, counting them', async () => {
      const result = await list();

      const todo = result.items.find((item) => item.conflictKey === KEY_MAIN);
      expect(todo?.recordCount).toBe(2);
      expect(result.days).toBe(90);
      expect(todo?.readAt).toBeNull();
    });

    itWithDb('bounds the scan by the requested window, in both directions', async () => {
      // 40 days old: inside the default 90, outside a 7-day window.
      expect((await list()).items.map((item) => item.conflictKey)).toContain(KEY_OLD);
      expect((await list({ days: 7 })).items.map((item) => item.conflictKey)).not.toContain(
        KEY_OLD,
      );
    });

    itWithDb('puts unread first, most recently seen first within that', async () => {
      const { items } = await list();

      expect(items.map((item) => item.conflictKey)).toEqual([KEY_MAIN, KEY_OLD]);
    });

    itWithDb('rejects an out-of-range window instead of clamping it', async () => {
      await agent.get('/api/monitor/level-conflicts').query({ days: 0 }).expect(400);
      await agent.get('/api/monitor/level-conflicts').query({ days: 366 }).expect(400);
    });

    itWithDb('carries configuration metadata only - no patient, no report body', async () => {
      const res = await agent.get('/api/monitor/level-conflicts').expect(200);
      const serialized = JSON.stringify(res.body);

      expect(serialized).not.toContain(REPORT);
      expect(serialized).not.toContain('合成分歧甲');
      expect(res.body).not.toHaveProperty('items.0.recordId');
      // And nothing that looks like a stored digest, as on every other surface.
      expect(serialized).not.toMatch(/\b[0-9a-f]{64}\b/);
    });
  });

  describe('the read state', () => {
    itWithDb('marks read, and the entry moves out of the unread set', async () => {
      const before = await list();
      const unreadBefore = before.unreadCount;

      const res = await agent.put(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(200);
      expect(res.body).toMatchObject({ conflictKey: KEY_MAIN });
      expect(res.body.readAt).not.toBeNull();

      const after = await list();
      expect(after.unreadCount).toBe(unreadBefore - 1);
      expect(after.items.find((item) => item.conflictKey === KEY_MAIN)?.readAt).toBe(
        res.body.readAt,
      );
      // Read entries sink below the unread ones rather than disappearing.
      expect(after.items.map((item) => item.conflictKey)).toEqual([KEY_OLD, KEY_MAIN]);
    });

    itWithDb('filters by read state on request, without changing the counts', async () => {
      const unread = await list({ read: false });
      const read = await list({ read: true });

      expect(unread.items.map((item) => item.conflictKey)).toEqual([KEY_OLD]);
      expect(read.items.map((item) => item.conflictKey)).toEqual([KEY_MAIN]);
      // The unfiltered list is the same either way: `read` narrows the view, it
      // does not redefine the work.
      expect(unread.unreadCount).toBe((await list()).unreadCount);
    });

    itWithDb('is idempotent: marking read twice keeps one row and still answers 200', async () => {
      const first = await agent
        .put(`/api/monitor/level-conflicts/${KEY_MAIN}/read`)
        .expect(200);

      const rows = await prisma.monitorLevelConflictRead.count({ where: { conflictKey: KEY_MAIN } });
      expect(rows).toBe(1);
      // The second call is a success, not a conflict - the caller asked for a
      // state, and that state holds.
      expect(first.body.readAt).not.toBeNull();
      await agent.put(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(200);
      expect(await prisma.monitorLevelConflictRead.count({ where: { conflictKey: KEY_MAIN } })).toBe(
        1,
      );
    });

    itWithDb('marks unread again, keeping the row rather than deleting it', async () => {
      const res = await agent.delete(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(200);
      expect(res.body).toEqual({ conflictKey: KEY_MAIN, readAt: null });

      expect((await list()).items.find((item) => item.conflictKey === KEY_MAIN)?.readAt).toBeNull();
      // The row survives so that "someone looked and decided it was not worth
      // acting on" is still answerable later.
      expect(await prisma.monitorLevelConflictRead.count({ where: { conflictKey: KEY_MAIN } })).toBe(
        1,
      );
    });

    itWithDb('marking unread succeeds for a key that was never read', async () => {
      await agent.delete(`/api/monitor/level-conflicts/${KEY_OLD}/read`).expect(200);
      expect(await prisma.monitorLevelConflictRead.count({ where: { conflictKey: KEY_OLD } })).toBe(
        0,
      );
    });

    itWithDb('rejects a key it could not have issued, and stores nothing', async () => {
      for (const bad of [
        'not-a-key',
        `${RULE_A_GROUP}:${SEMANTIC_RED_GROUP}:EXAM_ITEM:YELLOW:RED`,
        `${RULE_A_GROUP}:${SEMANTIC_RED_GROUP}:FINDINGS:YELLOW:PURPLE`,
      ]) {
        const res = await agent.put(`/api/monitor/level-conflicts/${bad}/read`).expect(400);
        // The global exception filter's envelope: { error: { code, message, ... } }.
        expect(res.body).toMatchObject({ error: { code: 'LEVEL_CONFLICT_KEY_INVALID' } });
        // The rejected value is not echoed back.
        expect(JSON.stringify(res.body)).not.toContain(bad);
      }
      expect(await prisma.monitorLevelConflictRead.count()).toBe(1); // KEY_MAIN only
    });

    itWithDb('records the actor and the key in the audit trail', async () => {
      await prisma.auditLog.deleteMany({});
      await agent.put(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(200);
      await agent.delete(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(200);

      const logs = await prisma.auditLog.findMany({
        where: { action: { in: ['MONITOR_LEVEL_CONFLICT_READ', 'MONITOR_LEVEL_CONFLICT_UNREAD'] } },
        orderBy: { createdAt: 'asc' },
      });

      expect(logs.map((log) => log.action)).toEqual([
        'MONITOR_LEVEL_CONFLICT_READ',
        'MONITOR_LEVEL_CONFLICT_UNREAD',
      ]);
      for (const log of logs) {
        // The actor comes from the session, never from the request body.
        expect(log.actorUsername).toBe(authUsername);
        expect(log.resourceType).toBe('monitor_level_conflict_read');
        // Null, because the column is a Uuid and a conflict key is not one.
        expect(log.resourceId).toBeNull();
        expect(log.meta).toMatchObject({ conflictKey: KEY_MAIN });
      }
    });
  });

  describe('authorization', () => {
    itWithDb('is RULE_ADMIN only, reads included', async () => {
      await viewerAgent.get('/api/monitor/level-conflicts').expect(403);
      await viewerAgent.put(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(403);
      await viewerAgent.delete(`/api/monitor/level-conflicts/${KEY_MAIN}/read`).expect(403);
    });

    itWithDb('turns an anonymous caller away', async () => {
      await request(app.getHttpServer()).get('/api/monitor/level-conflicts').expect(401);
    });

    itWithDb('lets the viewer keep reading the doctor-facing drawer', async () => {
      // The gate is on the admin work queue, not on the conflict itself - a
      // doctor still sees the notice on the record they are looking at.
      const res = await viewerAgent.get(`/api/monitor/exams/${ids.main1}`).expect(200);
      expect((res.body as MonitorExamWorkbenchDetailDto).levelConflicts).toHaveLength(1);
    });
  });
});
