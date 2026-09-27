import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';
import { DEFAULT_ATTENTION_SEMANTICS } from '../src/attention-semantics/defaults';

/**
 * Full-stack e2e test for issue #88's attention-semantic configuration API
 * against a REAL Postgres with the migration applied - the same shape as
 * rules.e2e-spec.ts (issue #4), because this is the same kind of resource:
 * an admin-configured, versioned, optimistic-locked catalogue.
 *
 * What this suite is here to prove, beyond the CRUD working:
 *
 *  1. A semantic EDIT versions rather than overwrites. Historical AI findings
 *     point at a specific version row, so wording (and colour) must be
 *     immutable once a report has been judged against it.
 *  2. Presets are loaded ONLY by an explicit call - no migration or seed writes
 *     medical semantics - and loading them twice does not re-colour a meaning a
 *     doctor already reviewed.
 *  3. Writes are RULE_ADMIN-only; a VIEWER can read the configuration and
 *     cannot change it.
 *
 * Like rules.e2e-spec.ts, this suite probes connectivity in beforeAll and every
 * test becomes a no-op when DATABASE_URL does not point at a reachable,
 * migrated Postgres, so the DB-free `pnpm run test` job stays DB-free.
 */
describe('Attention semantics API (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let agent: ReturnType<typeof request.agent>;
  let viewerAgent: ReturnType<typeof request.agent>;
  const authUsername = 'attention-e2e-admin';
  const authPassword = 'synthetic-attention-password';
  const viewerUsername = 'attention-e2e-viewer';

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      // Fails fast if DATABASE_URL is unreachable or the #88 migration has not
      // been applied (the table is the marker).
      await prisma.$queryRaw`SELECT 1`;
      await prisma.attentionSemantic.findFirst();
      await prisma.appUser.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping attention-semantics e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite.',
      );
      return;
    }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // app_user_access is keyed by username with no FK to app_user, so a stale
    // grant from an earlier run must be cleared explicitly - otherwise a crashed
    // run could leave `viewerUsername` holding RULE_ADMIN and the 403 test below
    // would pass for the wrong reason.
    await prisma.appUserAccess.deleteMany({
      where: { username: { in: [authUsername, viewerUsername] } },
    });
    for (const [username, displayName, roles] of [
      [authUsername, '关注语义接口测试管理员', ['RULE_ADMIN']],
      [viewerUsername, '关注语义接口测试只读用户', ['VIEWER']],
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
          patientDetail: false,
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
      await prisma.attentionSemantic.deleteMany({});
      await prisma.auditLog.deleteMany({});
      await prisma.appUserAccess.deleteMany({
        where: { username: { in: [authUsername, viewerUsername] } },
      });
      await prisma.appUser.deleteMany({ where: { username: { in: [authUsername, viewerUsername] } } });
    }
    if (app) await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Clean slate. attention_semantic has no FK dependents in this suite's
    // scope (monitor_report_ai_match is only written by the worker's classifier,
    // which never runs here).
    await prisma.attentionSemantic.deleteMany({});
  });

  /**
   * `it.skip` cannot be chosen dynamically - Jest collects the describe block
   * synchronously, before beforeAll has run - so every body checks the flag and
   * returns (counted as passing, not failing) when no DB is available. Same
   * helper as rules.e2e-spec.ts.
   */
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
        'attention-semantics.e2e-spec.ts: all subsequent cases are NO-OPS because no live Postgres was reachable.',
      );
    }
    expect(true).toBe(true);
  });

  itWithDb(
    'full lifecycle: create -> list -> get -> disable (in place) -> edit (versioned)',
    async () => {
      const createRes = await agent
        .post('/api/attention-semantics')
        .send({
          name: '明确或高度疑似恶性病变',
          description: '报告描述了提示恶性或高度可疑恶性的表现。',
          attentionLevel: 'RED',
          actorId: 'tester',
        })
        .expect(201);

      expect(createRes.body.name).toBe('明确或高度疑似恶性病变');
      expect(createRes.body.attentionLevel).toBe('RED');
      expect(createRes.body.isEnabled).toBe(true);
      expect(createRes.body.version).toBe(1);
      // The create-then-patch anchor: a new entry is its own group head.
      expect(createRes.body.semanticGroupId).toBe(createRes.body.id);
      const semanticId = createRes.body.id;

      const listRes = await agent
        .get('/api/attention-semantics')
        .query({ name: '恶性' })
        .expect(200);
      expect(listRes.body.total).toBe(1);
      expect(listRes.body.items[0].id).toBe(semanticId);

      const getRes = await agent.get(`/api/attention-semantics/${semanticId}`).expect(200);
      expect(getRes.body.description).toBe('报告描述了提示恶性或高度可疑恶性的表现。');

      // Disable: a non-semantic change, so it edits IN PLACE - but `version`
      // still increments, so two operators disabling from a stale read cannot
      // both succeed.
      const disableRes = await agent
        .put(`/api/attention-semantics/${semanticId}`)
        .send({ version: 1, isEnabled: false, actorId: 'editor' })
        .expect(200);
      expect(disableRes.body.id).toBe(semanticId);
      expect(disableRes.body.isEnabled).toBe(false);
      expect(disableRes.body.version).toBe(2);

      // Changing the description is a SEMANTIC change -> a NEW row, and the old
      // one is disabled rather than rewritten. This is what keeps a historical
      // AI finding's semanticId pointing at the wording that was actually used.
      const versionedRes = await agent
        .put(`/api/attention-semantics/${semanticId}`)
        .send({
          version: 2,
          description: '报告描述了提示恶性或高度可疑恶性的表现，例如不规则隆起、质脆易出血。',
          attentionLevel: 'RED',
          isEnabled: true,
          actorId: 'editor',
        })
        .expect(200);
      expect(versionedRes.body.id).not.toBe(semanticId);
      expect(versionedRes.body.version).toBe(3);
      expect(versionedRes.body.semanticGroupId).toBe(semanticId);

      const oldRow = await agent.get(`/api/attention-semantics/${semanticId}`).expect(200);
      expect(oldRow.body.isEnabled).toBe(false);
      expect(oldRow.body.version).toBe(2);
    },
  );

  itWithDb('rejects a duplicate enabled name with ATTENTION_SEMANTIC_CONFLICT', async () => {
    const first = await agent
      .post('/api/attention-semantics')
      .send({
        name: '活动性出血',
        description: '报告描述活动性出血或近期出血征象。',
        attentionLevel: 'RED',
        actorId: 'tester',
      })
      .expect(201);

    const dupRes = await agent
      .post('/api/attention-semantics')
      // Case-insensitive duplicate: the same meaning under a different casing is
      // still the same meaning.
      .send({
        name: '活动性出血',
        description: '换一种说法。',
        attentionLevel: 'YELLOW',
        actorId: 'tester',
      })
      .expect(409);

    expect(dupRes.body.error.code).toBe('ATTENTION_SEMANTIC_CONFLICT');
    expect(dupRes.body.error.details.conflictingSemanticId).toBe(first.body.id);
    expect(dupRes.body.error.correlationId).toBeDefined();
  });

  itWithDb(
    'returns 409 ATTENTION_SEMANTIC_VERSION_CONFLICT for a stale edit against a superseded version',
    async () => {
      const created = await agent
        .post('/api/attention-semantics')
        .send({
          name: '性质待定的病变',
          description: '报告提示性质待定，需要活检或短期复查。',
          attentionLevel: 'YELLOW',
          actorId: 'tester',
        })
        .expect(201);

      // editor-a's edit lands first: new row, version 2, the original disabled.
      await agent
        .put(`/api/attention-semantics/${created.body.id}`)
        .send({ version: 1, description: '改写后的说明文字。', actorId: 'editor-a' })
        .expect(200);

      // editor-b still holds version 1 of the ORIGINAL id. That row is now a
      // superseded, disabled version - editing it would fork a second history
      // off the same logical semantic, so it must be refused.
      const staleRes = await agent
        .put(`/api/attention-semantics/${created.body.id}`)
        .send({ version: 1, description: '另一个人的改写。', actorId: 'editor-b' })
        .expect(409);

      expect(staleRes.body.error.code).toBe('ATTENTION_SEMANTIC_VERSION_CONFLICT');
    },
  );

  itWithDb(
    'returns 409 ATTENTION_SEMANTIC_VERSION_CONFLICT for a stale in-place edit too',
    async () => {
      const created = await agent
        .post('/api/attention-semantics')
        .send({
          name: '多发病变',
          description: '报告描述多发病变或累及范围广泛。',
          attentionLevel: 'YELLOW',
          actorId: 'tester',
        })
        .expect(201);

      // Two operators both read version 1. The first disable lands in place and
      // bumps the version to 2 precisely so the second is detectable.
      await agent
        .put(`/api/attention-semantics/${created.body.id}`)
        .send({ version: 1, isEnabled: false, actorId: 'editor-a' })
        .expect(200);

      const staleRes = await agent
        .put(`/api/attention-semantics/${created.body.id}`)
        .send({ version: 1, isEnabled: false, actorId: 'editor-b' })
        .expect(409);

      expect(staleRes.body.error.code).toBe('ATTENTION_SEMANTIC_VERSION_CONFLICT');
    },
  );

  itWithDb('rejects an illegal attentionLevel with a 400 and the unified error shape', async () => {
    const res = await agent
      .post('/api/attention-semantics')
      .send({
        name: 'x',
        description: 'y',
        attentionLevel: 'CRITICAL',
        actorId: 'tester',
      })
      .expect(400);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toMatch(/attentionLevel/i);
  });

  itWithDb('rejects a blank name and a blank description with a 400', async () => {
    await agent
      .post('/api/attention-semantics')
      .send({ name: '   ', description: '有说明', attentionLevel: 'RED', actorId: 'tester' })
      .expect(400);

    // The description is not cosmetic - it is the text the classifier reads -
    // so an empty one is not an acceptable configuration.
    await agent
      .post('/api/attention-semantics')
      .send({ name: '名称', description: '   ', attentionLevel: 'RED', actorId: 'tester' })
      .expect(400);
  });

  itWithDb('requires the optimistic-lock version on PUT', async () => {
    const created = await agent
      .post('/api/attention-semantics')
      .send({
        name: '与既往比较出现变化',
        description: '报告提示与既往检查相比出现变化。',
        attentionLevel: 'GREEN',
        actorId: 'tester',
      })
      .expect(201);

    await agent
      .put(`/api/attention-semantics/${created.body.id}`)
      .send({ isEnabled: false, actorId: 'editor' })
      .expect(400);
  });

  itWithDb('returns 404 ATTENTION_SEMANTIC_NOT_FOUND for an unknown id', async () => {
    const res = await agent
      .get('/api/attention-semantics/00000000-0000-0000-0000-000000000000')
      .expect(404);
    expect(res.body.error.code).toBe('ATTENTION_SEMANTIC_NOT_FOUND');
  });

  // --- Preset templates (owner decision: explicit load only) ----------------

  itWithDb('import-defaults creates every preset, and only when explicitly called', async () => {
    // Nothing writes medical semantics automatically: before this call there is
    // no configuration at all, and the classifier reports NO_SEMANTICS.
    expect(await prisma.attentionSemantic.count()).toBe(0);

    const res = await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'importer' })
      .expect(201);

    expect(res.body.createdCount).toBe(DEFAULT_ATTENTION_SEMANTICS.length);
    expect(res.body.skippedCount).toBe(0);
    expect(res.body.updatedCount).toBe(0);
    expect(res.body.semanticIds).toHaveLength(DEFAULT_ATTENTION_SEMANTICS.length);

    const listRes = await agent
      .get('/api/attention-semantics')
      .query({ isEnabled: true })
      .expect(200);
    expect(listRes.body.total).toBe(DEFAULT_ATTENTION_SEMANTICS.length);
  });

  itWithDb('import-defaults is idempotent and never re-colours an existing entry', async () => {
    const first = await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'importer' })
      .expect(201);

    // The hospital reviews one preset and moves it to a different colour. The
    // wording is otherwise identical, so only the colour differs.
    const target = DEFAULT_ATTENTION_SEMANTICS[0];
    const reColoured = await agent
      .put(`/api/attention-semantics/${first.body.semanticIds[0]}`)
      .send({
        version: 1,
        attentionLevel: target.attentionLevel === 'RED' ? 'YELLOW' : 'RED',
        actorId: 'reviewer',
      })
      .expect(200);

    const second = await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'importer' })
      .expect(201);

    // A button press must not silently undo a doctor's review.
    expect(second.body.createdCount).toBe(0);
    expect(second.body.updatedCount).toBe(0);
    expect(second.body.skippedCount).toBe(DEFAULT_ATTENTION_SEMANTICS.length);

    const after = await agent.get(`/api/attention-semantics/${reColoured.body.id}`).expect(200);
    expect(after.body.attentionLevel).toBe(reColoured.body.attentionLevel);
  });

  itWithDb('import-defaults only overwrites when asked, and versions rather than rewriting', async () => {
    const first = await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'importer' })
      .expect(201);
    const originalId = first.body.semanticIds[0];

    // Same name, different text: an edit the preset would otherwise discard.
    const edited = await agent
      .put(`/api/attention-semantics/${originalId}`)
      .send({ version: 1, description: '医院自己改写的说明文字。', actorId: 'reviewer' })
      .expect(200);

    const overwrite = await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ overwriteExisting: true, actorId: 'importer' })
      .expect(201);

    // ONE entry conflicted (the other presets are untouched by the edit).
    expect(overwrite.body.updatedCount).toBe(1);
    expect(overwrite.body.createdCount).toBe(0);

    // The hospital's own wording is disabled, not deleted - a past AI finding
    // that used it still resolves to a readable row.
    const superseded = await agent.get(`/api/attention-semantics/${edited.body.id}`).expect(200);
    expect(superseded.body.isEnabled).toBe(false);
    expect(superseded.body.description).toBe('医院自己改写的说明文字。');

    const current = await agent
      .get(`/api/attention-semantics/${overwrite.body.semanticIds[0]}`)
      .expect(200);
    expect(current.body.isEnabled).toBe(true);
    expect(current.body.description).toBe(DEFAULT_ATTENTION_SEMANTICS[0].description);
    expect(current.body.semanticGroupId).toBe(edited.body.semanticGroupId);
  });

  // --- Authorization -------------------------------------------------------

  itWithDb('lets a VIEWER read the configuration', async () => {
    await agent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'importer' })
      .expect(201);

    // Applying the hospital's attention semantics is work a doctor needs to be
    // able to inspect, not an admin-only secret.
    const listRes = await viewerAgent.get('/api/attention-semantics').expect(200);
    expect(listRes.body.total).toBe(DEFAULT_ATTENTION_SEMANTICS.length);
  });

  itWithDb('refuses every WRITE from a VIEWER', async () => {
    const created = await agent
      .post('/api/attention-semantics')
      .send({
        name: 'V测试语义',
        description: '用于校验权限的说明文字。',
        attentionLevel: 'GREEN',
        actorId: 'tester',
      })
      .expect(201);

    // "Which meanings this hospital watches for" is the same administrative
    // responsibility as "which keywords it watches for" - RULE_ADMIN, not
    // every authenticated user.
    await viewerAgent
      .post('/api/attention-semantics')
      .send({
        name: 'V越权新建',
        description: '不应被创建。',
        attentionLevel: 'RED',
        actorId: 'viewer',
      })
      .expect(403);

    await viewerAgent
      .put(`/api/attention-semantics/${created.body.id}`)
      .send({ version: 1, isEnabled: false, actorId: 'viewer' })
      .expect(403);

    await viewerAgent
      .post('/api/attention-semantics/import-defaults')
      .send({ actorId: 'viewer' })
      .expect(403);

    expect(await prisma.attentionSemantic.count()).toBe(1);
    const unchanged = await agent.get(`/api/attention-semantics/${created.body.id}`).expect(200);
    expect(unchanged.body.isEnabled).toBe(true);
    expect(unchanged.body.version).toBe(1);
  });

  itWithDb('records an audit row for every configuration write', async () => {
    const created = await agent
      .post('/api/attention-semantics')
      .send({
        name: 'A审计测试语义',
        description: '用于校验审计记录的说明文字。',
        attentionLevel: 'YELLOW',
        actorId: 'ignored-by-server',
      })
      .expect(201);

    const rows = await prisma.auditLog.findMany({
      where: { resourceType: 'attention_semantic', resourceId: created.body.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('ATTENTION_SEMANTIC_CREATE');
    // The AUTHENTICATED username, not the deprecated body actorId.
    expect(rows[0].actorUsername).toBe(authUsername);
    expect(rows[0].resourceId).toBe(created.body.id);
    // Configuration only - no patient data, no report text.
    expect(rows[0].meta).toMatchObject({ attentionLevel: 'YELLOW', version: 1 });
  });
});
