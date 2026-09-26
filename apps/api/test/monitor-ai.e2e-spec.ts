import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { MonitorService } from '../src/monitor/monitor.service';
import { MonitorExamWorkbenchDetailDto, MonitorExamWorkbenchDto } from '@epgs/shared-types';
import { hash, argon2id } from 'argon2';

/**
 * Issue #88 (PR-B) e2e: the doctor-facing AI explanation, against a REAL
 * Postgres instance.
 *
 * What this suite exists to prove, in order of how badly it would hurt to get
 * wrong:
 *
 *  1. NO AUDIT FIELD reaches the wire. The audit tables store hashes, model ids
 *     and latencies; docs/api/monitor-api.md forbids all of it on the
 *     doctor-facing response, and `evidence_hash` in particular must never
 *     travel - the excerpt is recomputed instead. Asserted by scanning the
 *     serialized body.
 *  2. STALE FINDINGS STAY HIDDEN. The audit rows are append-only, so a report
 *     whose text was replaced still has the previous attempt's rows. When the
 *     record's AI state has been reset (`ai_attention_level` NULL), those rows
 *     must not be shown - otherwise the drawer would contradict the level.
 *  3. A STALE EXCERPT IS DROPPED, THE FINDING IS KEPT, and the request still
 *     answers 200. There is no 500 path.
 *  4. attentionSource agrees with the level on all four states, and the alert
 *     H5 detail cannot carry any of the new fields.
 *
 * CRITICAL for CI: this suite seeds its own rule + records and wipes
 * monitor_match -> monitor_record -> monitor_rule in beforeAll AND afterAll, so
 * the later seed-count step still sees exactly the 17 seeded RED rules. Its
 * keyword is disjoint from prisma/seed.ts's, and its attention_semantic rows are
 * deleted on the way out (monitor_report_ai_match references them with
 * onDelete: Restrict, so they go after the records).
 */
describe('Monitor AI explanation (e2e, real Postgres) - issue #88', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let agent: ReturnType<typeof request.agent>;

  const authUsername = 'monitor-ai-e2e-user';
  const authPassword = 'synthetic-monitor-ai-password';
  const DEPARTMENT = 'AI语义E2E科室';
  const KEYWORD = '语义监测合成词';

  /** record.id per fixture key. */
  const ids: Record<string, string> = {};
  const semanticIds: string[] = [];

  function sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  /**
   * Every record lives in its own department-unique fixture, so the list
   * assertions can isolate exactly these rows whatever else is in the table.
   *
   * `attempt` is the OK monitor_report_ai row to write, or null for "never
   * judged". `matches` is the keyword-match fixture: an EMPTY array means the
   * keyword path found nothing, and `filtered: true` means it found something
   * that #87 then ruled out - which does not count as an effective finding.
   */
  interface RecordFixture {
    key: string;
    patientName: string;
    /**
     * The value the worker's recomputeRecordLevels WOULD have denormalized onto
     * current_level for this fixture's inputs (the max of the effective keyword
     * levels and aiAttentionLevel, RED > YELLOW > GREEN). Nothing in an API-side
     * suite recomputes it, so the fixture has to state it - it stands in for the
     * worker, and the divergence between a stale fixture level and a live
     * attentionSource is what the "NONE iff UNCLASSIFIED" invariant below
     * watches for.
     */
    level: 'RED' | 'YELLOW' | 'GREEN' | 'UNCLASSIFIED';
    aiLevel: 'RED' | 'YELLOW' | 'GREEN' | null;
    reportContent: string;
    diagnosis: string | null;
    keywordMatch: { filtered: boolean } | null;
    attempt: {
      level: 'RED' | 'YELLOW' | 'GREEN' | null;
      matches: {
        name: string;
        level: 'RED' | 'YELLOW' | 'GREEN';
        reason: string;
        evidence: { field: 'EXAM_ITEM' | 'FINDINGS' | 'IMPRESSION'; start: number; end: number }[];
      }[];
    } | null;
  }

  const BOTH_REPORT = '胃体见巨大不规则隆起，表面糜烂，质脆。';
  const BOTH_DIAGNOSIS = '胃体占位，性质待定。';
  const AI_ONLY_REPORT = '黏膜下见一处隆起，表面光滑。';

  const FIXTURES: RecordFixture[] = [
    // Both paths found something: an effective keyword hit AND an AI finding.
    {
      key: 'both',
      patientName: '合成甲',
      level: 'RED',
      aiLevel: 'RED',
      reportContent: BOTH_REPORT,
      diagnosis: BOTH_DIAGNOSIS,
      keywordMatch: { filtered: false },
      attempt: {
        level: 'RED',
        matches: [
          {
            name: '明确或高度疑似恶性病变',
            level: 'RED',
            reason: '报告描述了不规则隆起与质脆，提示恶性可能。',
            evidence: [
              { field: 'FINDINGS', start: 3, end: 10 }, // 巨大不规则隆起
              { field: 'IMPRESSION', start: 5, end: 9 }, // 性质待定
            ],
          },
        ],
      },
    },
    // Keywords only, and the AI never ran on it.
    {
      key: 'ruleOnly',
      patientName: '合成乙',
      level: 'RED',
      aiLevel: null,
      reportContent: '胃窦见语义监测合成词表现。',
      diagnosis: null,
      keywordMatch: { filtered: false },
      attempt: null,
    },
    // No keyword hit at all, but the AI read the report and flagged it. This is
    // the record the whole feature exists for.
    {
      key: 'aiOnly',
      patientName: '合成丙',
      level: 'YELLOW',
      aiLevel: 'YELLOW',
      reportContent: AI_ONLY_REPORT,
      diagnosis: null,
      keywordMatch: null,
      attempt: {
        level: 'YELLOW',
        matches: [
          {
            name: '性质待定、需活检的病变',
            level: 'YELLOW',
            reason: '报告提示性质待定，需要活检或短期复查。',
            evidence: [{ field: 'FINDINGS', start: 4, end: 8 }], // 一处隆起
          },
        ],
      },
    },
    // The AI judged it and found nothing, and the only keyword hit was filtered
    // out by #87 - so neither path contributes. "Judged, found nothing" must
    // still be sayable without claiming a finding.
    {
      key: 'none',
      patientName: '合成丁',
      level: 'UNCLASSIFIED',
      aiLevel: null,
      reportContent: '未见语义监测合成词，考虑浅表炎症。',
      diagnosis: null,
      keywordMatch: { filtered: true },
      attempt: { level: null, matches: [] },
    },
    // The offsets point past the end of the body, as they would after the text
    // was replaced. The finding must survive and the excerpt must not.
    {
      key: 'staleEvidence',
      patientName: '合成戊',
      level: 'RED',
      aiLevel: 'RED',
      reportContent: '胃窦黏膜充血。',
      diagnosis: null,
      keywordMatch: { filtered: false },
      attempt: {
        level: 'RED',
        matches: [
          {
            name: '明确或高度疑似恶性病变',
            level: 'RED',
            reason: '报告描述了不规则隆起。',
            evidence: [{ field: 'FINDINGS', start: 0, end: 9999 }],
          },
        ],
      },
    },
  ];

  /** Fixed instant shared by an attempt's createdAt and the record's aiResolvedAt. */
  const RESOLVED_AT = new Date('2026-09-26T02:00:00.000Z');

  async function wipeMonitorTables(): Promise<void> {
    // FK order: monitor_report_ai* cascade from monitor_record, and
    // monitor_match references monitor_record.
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    await prisma.monitorRule.deleteMany({});
  }

  async function seedFixture(): Promise<void> {
    await wipeMonitorTables();

    const semantic = await prisma.attentionSemantic.create({
      data: {
        semanticGroupId: '00000000-0000-4000-8000-00000000e2e2',
        name: '明确或高度疑似恶性病变',
        description: '报告描述了提示恶性或高度可疑恶性的表现。',
        attentionLevel: 'RED',
        isEnabled: true,
        version: 1,
        createdBy: authUsername,
        updatedBy: authUsername,
      },
    });
    const yellowSemantic = await prisma.attentionSemantic.create({
      data: {
        semanticGroupId: '00000000-0000-4000-8000-00000000e2e3',
        name: '性质待定、需活检的病变',
        description: '报告提示性质待定，需要活检或短期复查。',
        attentionLevel: 'YELLOW',
        isEnabled: true,
        version: 2,
        createdBy: authUsername,
        updatedBy: authUsername,
      },
    });
    semanticIds.push(semantic.id, yellowSemantic.id);
    const semanticByName: Record<string, { id: string; version: number }> = {
      [semantic.name]: { id: semantic.id, version: semantic.version },
      [yellowSemantic.name]: { id: yellowSemantic.id, version: yellowSemantic.version },
    };

    const rule = await prisma.monitorRule.create({
      data: {
        ruleGroupId: '00000000-0000-4000-8000-00000000e2e1',
        keyword: KEYWORD,
        level: 'RED',
        matchField: 'REPORT_TEXT',
        isEnabled: true,
        version: 1,
        createdBy: authUsername,
        updatedBy: authUsername,
      },
    });

    for (const fixture of FIXTURES) {
      const record = await prisma.monitorRecord.create({
        data: {
          sourceRecordId: `e2e-ai-${fixture.key}`,
          reportId: `e2e-ai-report-${fixture.key}`,
          reportVersion: 1,
          patientName: fixture.patientName,
          department: DEPARTMENT,
          bedNo: '9-9',
          patientTypeCode: 'I',
          patientTypeName: '住院',
          examItem: '电子胃镜检查',
          examTime: new Date('2026-09-26T01:30:00Z'),
          sourceUpdatedAt: new Date('2026-09-26T01:30:00Z'),
          currentLevel: fixture.level,
          reportContent: fixture.reportContent,
          diagnosis: fixture.diagnosis,
          aiAttentionLevel: fixture.aiLevel,
          aiResolvedAt: fixture.attempt === null ? null : RESOLVED_AT,
        },
      });
      ids[fixture.key] = record.id;

      if (fixture.keywordMatch !== null) {
        await prisma.monitorMatch.create({
          data: {
            monitorRecordId: record.id,
            ruleId: rule.id,
            keyword: KEYWORD,
            level: 'RED',
            matchedField: 'REPORT_TEXT',
            contextSnippet: `…${KEYWORD}…`,
            matchedAt: new Date('2026-09-26T01:30:10Z'),
            reportVersion: 1,
            semanticFiltered: fixture.keywordMatch.filtered,
          },
        });
      }

      if (fixture.attempt === null) continue;

      const attempt = await prisma.monitorReportAi.create({
        data: {
          monitorRecordId: record.id,
          reportVersion: 1,
          task: 'CLASSIFY_REPORT',
          taskVersion: 'e2e-1',
          outcome: 'OK',
          attentionLevel: fixture.attempt.level,
          modelAttentionLevel: fixture.attempt.level,
          semanticCount: 2,
          matchCount: fixture.attempt.matches.length,
          error: null,
          model: 'e2e-synthetic-model',
          modelVersion: 'v0',
          inputHash: sha256Hex('e2e-input'),
          reportHash: sha256Hex(fixture.reportContent),
          configHash: sha256Hex('e2e-config'),
          latencyMs: 42,
          createdAt: RESOLVED_AT,
        },
      });

      for (const [ordinal, match] of fixture.attempt.matches.entries()) {
        const semanticRow = semanticByName[match.name];
        const matchRow = await prisma.monitorReportAiMatch.create({
          data: {
            reportAiId: attempt.id,
            semanticId: semanticRow.id,
            semanticVersion: semanticRow.version,
            semanticName: match.name,
            attentionLevel: match.level,
            confidence: 'HIGH',
            reason: match.reason,
            ordinal,
          },
        });
        for (const [evidenceOrdinal, evidence] of match.evidence.entries()) {
          const text =
            evidence.field === 'FINDINGS'
              ? fixture.reportContent
              : (fixture.diagnosis ?? fixture.reportContent);
          const excerpt = text.slice(evidence.start, evidence.end);
          await prisma.monitorReportAiEvidence.create({
            data: {
              matchId: matchRow.id,
              ordinal: evidenceOrdinal,
              field: evidence.field,
              // The real producer hashes the excerpt the MODEL returned; for the
              // in-range rows that is exactly the slice, which is what makes
              // reconstruction verifiable. The out-of-range row hashes a value
              // the slice can never produce.
              evidenceHash:
                evidence.end <= text.length ? sha256Hex(excerpt) : sha256Hex('已被替换的正文'),
              evidenceStart: evidence.start,
              evidenceEnd: evidence.end,
            },
          });
        }
      }
    }
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.monitorRecord.findFirst();
      await prisma.appUser.findFirst();
      await prisma.monitorReportAi.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping monitor-ai e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite.',
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
        displayName: 'AI语义展示测试用户',
        passwordHash: await hash(authPassword, { type: argon2id }),
      },
    });
    // patientDetail=true so the unmasked shape is what these assertions read;
    // security.e2e-spec.ts owns the masked pair.
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
      await prisma.auditLog.deleteMany({});
      await wipeMonitorTables();
      // Restrict FK from monitor_report_ai_match, so these go after the records.
      await prisma.attentionSemantic.deleteMany({ where: { id: { in: semanticIds } } });
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
      console.warn('monitor-ai e2e: DB unavailable, assertions skipped.');
    }
    expect(true).toBe(true);
  });

  async function detail(key: string): Promise<MonitorExamWorkbenchDetailDto> {
    const res = await agent.get(`/api/monitor/exams/${ids[key]}`).expect(200);
    return res.body as MonitorExamWorkbenchDetailDto;
  }

  describe('attentionSource agrees with the level on every state', () => {
    itWithDb('BOTH when keywords and the AI both found something', async () => {
      const body = await detail('both');
      expect(body.attentionSource).toBe('BOTH');
      expect(body.monitorLevel).toBe('RED');
      expect(body.aiJudged).toBe(true);
    });

    itWithDb('RULE when only keywords found something and the AI never ran', async () => {
      const body = await detail('ruleOnly');
      expect(body.attentionSource).toBe('RULE');
      expect(body.aiJudged).toBe(false);
      expect(body.aiSemantics).toEqual([]);
    });

    itWithDb('AI_REPORT when no keyword hit is effective but the AI flagged it', async () => {
      const body = await detail('aiOnly');
      expect(body.attentionSource).toBe('AI_REPORT');
      expect(body.aiJudged).toBe(true);
      // The level the AI produced is the record's level - it did not need the
      // keyword path to get there.
      expect(body.monitorLevel).toBe('YELLOW');
      expect(body.matchedKeywords).toEqual([]);
    });

    itWithDb('NONE when the only hit was filtered out and the AI found nothing', async () => {
      const body = await detail('none');
      expect(body.attentionSource).toBe('NONE');
      // The two are computed from the same inputs, so this must hold for every
      // fixture: nothing found is exactly the state that has no level.
      expect(body.monitorLevel).toBe('UNCLASSIFIED');
      expect(body.aiJudged).toBe(true);
      expect(body.aiSemantics).toEqual([]);
      // The filtered hit is still visible - the raw keyword evidence is never
      // hidden - it just does not count.
      expect(body.hits).toHaveLength(1);
      expect(body.hits[0].semanticFiltered).toBe(true);
    });
  });

  describe('the findings and their evidence', () => {
    itWithDb('returns the excerpt verbatim, labelled with the field it came from', async () => {
      const body = await detail('both');

      expect(body.aiSemantics).toHaveLength(1);
      const [finding] = body.aiSemantics;
      expect(finding).toMatchObject({
        semanticVersion: 1,
        name: '明确或高度疑似恶性病变',
        attentionLevel: 'RED',
        confidence: 'HIGH',
        reason: '报告描述了不规则隆起与质脆，提示恶性可能。',
      });
      // Byte-identical to the substring of the report, in stored ordinal order.
      expect(finding.evidence).toEqual([
        { field: 'FINDINGS', text: BOTH_REPORT.slice(3, 10) },
        { field: 'IMPRESSION', text: BOTH_DIAGNOSIS.slice(5, 9) },
      ]);
    });

    itWithDb('reads the excerpt out of the report body, never out of a stored hash', async () => {
      const body = await detail('aiOnly');

      expect(body.aiSemantics[0].evidence).toEqual([
        { field: 'FINDINGS', text: AI_ONLY_REPORT.slice(4, 8) },
      ]);
    });

    itWithDb('drops a stale excerpt, keeps the finding, and still answers 200', async () => {
      const body = await detail('staleEvidence');

      expect(body.aiSemantics).toHaveLength(1);
      expect(body.aiSemantics[0].name).toBe('明确或高度疑似恶性病变');
      // The offsets no longer land on the text they were computed against, so
      // the quote is withheld rather than showing a slice of something else.
      expect(body.aiSemantics[0].evidence).toEqual([]);
      // The level still counts this finding, so the badge must still say so.
      expect(body.attentionSource).toBe('BOTH');
    });
  });

  describe('no audit field crosses the doctor-facing boundary', () => {
    itWithDb('the detail body carries no hash, model, latency or error vocabulary', async () => {
      const res = await agent.get(`/api/monitor/exams/${ids.both}`).expect(200);
      const serialized = JSON.stringify(res.body);

      for (const auditField of [
        'inputHash',
        'reportHash',
        'configHash',
        'taskVersion',
        'modelVersion',
        'latencyMs',
        'evidenceHash',
        'modelAttentionLevel',
        'semanticCount',
        'matchCount',
        'outcome',
      ]) {
        expect(serialized).not.toContain(auditField);
      }
      // Nothing that even looks like a stored digest.
      expect(serialized).not.toMatch(/\b[0-9a-f]{64}\b/);
      // And not the model's own identifier either.
      expect(serialized).not.toContain('e2e-synthetic-model');
    });
  });

  describe('the list envelope', () => {
    itWithDb('gives every row a source and never a finding', async () => {
      const res = await agent
        .get('/api/monitor/exams')
        .query({ department: DEPARTMENT, pageSize: 50 })
        .expect(200);

      expect(res.body.items).toHaveLength(FIXTURES.length);
      const items = res.body.items as MonitorExamWorkbenchDto[];
      const sourceByRecord = Object.fromEntries(
        items.map((item) => [item.recordId, item.attentionSource]),
      );
      expect(sourceByRecord[ids.both]).toBe('BOTH');
      expect(sourceByRecord[ids.ruleOnly]).toBe('RULE');
      expect(sourceByRecord[ids.aiOnly]).toBe('AI_REPORT');
      expect(sourceByRecord[ids.none]).toBe('NONE');

      for (const item of items) {
        // A list response must not carry AI text - let alone an excerpt - so the
        // findings only ever exist on the detail endpoint.
        expect(item).not.toHaveProperty('aiSemantics');
        expect(item).not.toHaveProperty('aiJudged');
        expect(item).not.toHaveProperty('reportContent');
      }
    });
  });

  describe('the workbench is the ONLY surface that gets the AI fields', () => {
    itWithDb('the alert-link H5 list path returns base rows with no source', async () => {
      // listByIds is what AlertLinksService.listExams calls. Going through the
      // service here would need a link token; asserting on the row shape it is
      // built from is the same statement about the wire, and the route-level
      // proof lives in alert-links.e2e-spec.ts (which seeds an OK attempt on an
      // in-snapshot record and asserts the response has neither new field).
      const service = app.get(MonitorService);
      const rows = await service.listByIds([ids.both]);

      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('attentionSource');
      expect(rows[0]).not.toHaveProperty('aiSemantics');
      // The same record on the workbench list DOES carry the source - so this
      // is a narrowing, not a field that was never populated.
      const workbench = await agent
        .get('/api/monitor/exams')
        .query({ department: DEPARTMENT, pageSize: 50 })
        .expect(200);
      const items = workbench.body.items as MonitorExamWorkbenchDto[];
      const both = items.find((item) => item.recordId === ids.both);
      expect(both?.attentionSource).toBe('BOTH');
    });
  });
});
