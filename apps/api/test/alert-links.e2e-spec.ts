import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { hashAlertLinkToken } from '@epgs/notification-push';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';

/**
 * e2e for the WeCom alert-link surface (issue #72): the opaque link token as
 * the ONLY credential on /api/alert-links/*, the frozen-snapshot boundary
 * (list = exactly the snapshot; out-of-snapshot detail = 404), always-on name
 * masking with the report body kept, expiry (410) vs unknown (401), the open
 * counter, and - the security cross-cut - that a link token can NEVER reach
 * the cookie-authenticated workbench API.
 *
 * The no-token case is DB-free (the guard rejects before any query) and
 * always runs. Everything else follows the security suite's itWithDb
 * pattern: no-op when no migrated Postgres is reachable, real in the CI
 * db-migrations job. Seeds ONLY its own rows (TEST-AL-* source ids) and
 * deletes exactly those in afterAll - it never wipes shared tables, so it is
 * safe to run against a developer database.
 */
describe('Alert links (e2e): token credential, snapshot boundary, masking', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;

  const LIVE_TOKEN = 'e2eLiveToken_0123456789abcdefghijklmnopqrstuv';
  const EXPIRED_TOKEN = 'e2eExpiredToken_0123456789abcdefghijklmnopqrs';
  const UNKNOWN_TOKEN = 'e2eUnknownToken_0123456789abcdefghijklmnopqrs';

  const ids: { rule?: string; inSnapshot?: string; outOfSnapshot?: string; links: string[] } = {
    links: [],
  };

  async function seed(): Promise<void> {
    const ruleId = randomUUID();
    ids.rule = ruleId;
    await prisma.monitorRule.create({
      data: {
        id: ruleId,
        keyword: '疑似穿孔',
        level: 'RED',
        matchField: 'REPORT_TEXT',
        ruleGroupId: ruleId,
        createdBy: 'alert-links-e2e',
        updatedBy: 'alert-links-e2e',
      },
    });

    const examTime = new Date('2026-09-05T01:02:00Z');
    const inSnapshot = await prisma.monitorRecord.create({
      data: {
        sourceRecordId: 'TEST-AL-IN',
        reportId: 'TEST-AL-IN',
        reportVersion: 1,
        sourceUpdatedAt: examTime,
        patientName: '测试患者甲',
        department: '内镜中心',
        bedNo: '3床',
        patientTypeCode: 'I',
        patientTypeName: '住院',
        examItem: '无痛胃肠镜',
        examTime,
        currentLevel: 'RED',
        reportContent: '胃窦部见溃疡灶，局部浆膜层显示中断，不除外疑似穿孔可能。',
        diagnosis: '胃溃疡，疑似穿孔。',
      },
    });
    ids.inSnapshot = inSnapshot.id;
    await prisma.monitorMatch.create({
      data: {
        monitorRecordId: inSnapshot.id,
        ruleId,
        keyword: '疑似穿孔',
        level: 'RED',
        matchedField: 'REPORT_TEXT',
        contextSnippet: '…不除外疑似穿孔可能。',
        reportVersion: 1,
      },
    });

    // Same level, same day - but NOT in the snapshot: must stay invisible.
    const outOfSnapshot = await prisma.monitorRecord.create({
      data: {
        sourceRecordId: 'TEST-AL-OUT',
        reportId: 'TEST-AL-OUT',
        reportVersion: 1,
        sourceUpdatedAt: examTime,
        patientName: '测试患者乙',
        department: '内镜中心',
        bedNo: '5床',
        examTime,
        currentLevel: 'RED',
        reportContent: '不应通过旧链接可见。',
      },
    });
    ids.outOfSnapshot = outOfSnapshot.id;

    const live = await prisma.alertLink.create({
      data: {
        tokenHash: hashAlertLinkToken(LIVE_TOKEN),
        level: 'RED',
        windowDate: '2026-09-05',
        recordIds: [inSnapshot.id],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const expired = await prisma.alertLink.create({
      data: {
        tokenHash: hashAlertLinkToken(EXPIRED_TOKEN),
        level: 'RED',
        windowDate: '2026-09-04',
        recordIds: [inSnapshot.id],
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    ids.links.push(live.id, expired.id);
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.alertLink.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `alert-links.e2e-spec.ts: DB-gated cases are NO-OPS (no reachable/migrated Postgres: ${(err as Error).message}).`,
      );
    }
    if (dbAvailable) await seed();

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
  });

  afterAll(async () => {
    if (dbAvailable) {
      await prisma.alertLink.deleteMany({ where: { id: { in: ids.links } } });
      const recordIds = [ids.inSnapshot, ids.outOfSnapshot].filter((id): id is string => !!id);
      await prisma.monitorMatch.deleteMany({ where: { monitorRecordId: { in: recordIds } } });
      await prisma.monitorRecord.deleteMany({ where: { id: { in: recordIds } } });
      if (ids.rule) await prisma.monitorRule.deleteMany({ where: { id: ids.rule } });
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

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  // --- DB-free: the guard rejects before any query ----------------------

  it('rejects a missing or malformed token with 401 ALERT_LINK_INVALID (no DB needed)', async () => {
    const plain = request(app.getHttpServer());
    const missing = await plain.get('/api/alert-links/me').expect(401);
    expect(missing.body.error.code).toBe('ALERT_LINK_INVALID');
    expect(missing.body.error.correlationId).toBeDefined();

    const malformed = await plain
      .get('/api/alert-links/me/exams')
      .set('Authorization', 'Bearer not-long-enough')
      .expect(401);
    expect(malformed.body.error.code).toBe('ALERT_LINK_INVALID');

    // A workbench-style cookie session is NOT a valid credential here either.
    const cookie = await plain
      .get('/api/alert-links/me')
      .set('Cookie', 'epgs_session=whatever')
      .expect(401);
    expect(cookie.body.error.code).toBe('ALERT_LINK_INVALID');
  });

  // --- DB-gated --------------------------------------------------------

  itWithDb(
    'resolves a live token: summary with level/window/count and bumps the open counter',
    async () => {
      const before = await prisma.alertLink.findUniqueOrThrow({ where: { id: ids.links[0] } });

      const res = await request(app.getHttpServer())
        .get('/api/alert-links/me')
        .set(bearer(LIVE_TOKEN))
        .expect(200);

      expect(res.body).toMatchObject({ level: 'RED', windowDate: '2026-09-05', total: 1 });
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
      const after = await prisma.alertLink.findUniqueOrThrow({ where: { id: ids.links[0] } });
      expect(after.openCount).toBe(before.openCount + 1);
      expect(after.lastOpenedAt).not.toBeNull();
    },
  );

  itWithDb(
    'lists exactly the snapshot with the name masked and bed/department kept, no report body',
    async () => {
      const res = await request(app.getHttpServer())
        .get('/api/alert-links/me/exams')
        .set(bearer(LIVE_TOKEN))
        .expect(200);

      expect(res.body.total).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        recordId: ids.inSnapshot,
        monitorLevel: 'RED',
        patientName: '测****',
        bedNo: '3床',
        department: '内镜中心',
        matchedKeywords: ['疑似穿孔'],
      });
      expect(res.body.items[0]).not.toHaveProperty('reportContent');
      expect(JSON.stringify(res.body)).not.toContain(ids.outOfSnapshot);
      expect(JSON.stringify(res.body)).not.toContain('测试患者');
    },
  );

  itWithDb(
    'serves a snapshot record’s detail with the name masked but report, diagnosis and hits intact',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/alert-links/me/exams/${ids.inSnapshot}`)
        .set(bearer(LIVE_TOKEN))
        .expect(200);

      expect(res.body).toMatchObject({
        recordId: ids.inSnapshot,
        patientName: '测****',
        bedNo: '3床',
        reportContent: '胃窦部见溃疡灶，局部浆膜层显示中断，不除外疑似穿孔可能。',
        diagnosis: '胃溃疡，疑似穿孔。',
      });
      expect(res.body.hits).toHaveLength(1);
      expect(res.body.hits[0]).toMatchObject({
        keyword: '疑似穿孔',
        contextSnippet: '…不除外疑似穿孔可能。',
      });
      expect(res.body.dataAccess).toBeUndefined();
    },
  );

  itWithDb(
    'answers 404 for a same-level record that is outside the snapshot (frozen membership)',
    async () => {
      const res = await request(app.getHttpServer())
        .get(`/api/alert-links/me/exams/${ids.outOfSnapshot}`)
        .set(bearer(LIVE_TOKEN))
        .expect(404);
      expect(res.body.error.code).toBe('MONITOR_RECORD_NOT_FOUND');
    },
  );

  itWithDb(
    'answers 410 ALERT_LINK_EXPIRED for an expired token and 401 for an unknown one',
    async () => {
      const expired = await request(app.getHttpServer())
        .get('/api/alert-links/me')
        .set(bearer(EXPIRED_TOKEN))
        .expect(410);
      expect(expired.body.error.code).toBe('ALERT_LINK_EXPIRED');

      const unknown = await request(app.getHttpServer())
        .get('/api/alert-links/me')
        .set(bearer(UNKNOWN_TOKEN))
        .expect(401);
      expect(unknown.body.error.code).toBe('ALERT_LINK_INVALID');
    },
  );

  itWithDb(
    'a link token is NOT a workbench credential: cookie-guarded routes still answer 401',
    async () => {
      const plain = request(app.getHttpServer());
      for (const path of [
        '/api/monitor/exams',
        `/api/monitor/exams/${ids.inSnapshot}`,
        '/api/monitor/summary',
        '/api/auth/me',
      ]) {
        const res = await plain.get(path).set(bearer(LIVE_TOKEN)).expect(401);
        expect(res.body.error.code).toBe('AUTH_REQUIRED');
      }
    },
  );
});
