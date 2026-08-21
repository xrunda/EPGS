import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { hash, argon2id } from 'argon2';

/**
 * Full-stack e2e test for issue #4's rules API against a REAL Postgres
 * instance with the monitor_* migration applied - covers create, edit,
 * disable, duplicate, concurrent modification, illegal enum, and CSV
 * import (full success / partial failure / duplicate rows / encoding
 * error / empty file) per the issue's test requirements.
 *
 * Unlike apps/api/test/app.e2e-spec.ts (issue #1's DB-free suite), this
 * suite genuinely needs a database - the rules module is Prisma-backed
 * CRUD, there is no meaningful way to test it without one. Rather than
 * make the base `pnpm run test` job depend on a live Postgres (breaking
 * issue #1's CI design), this suite probes connectivity in beforeAll and
 * every test becomes a no-op (still reported as passing, not failing or
 * skipped - see the itWithDb helper below for why `it.skip` doesn't work
 * here) if DATABASE_URL doesn't point at a reachable, migrated Postgres.
 * It always runs for real in:
 *   - local verification (see docs/rules-api.md for the initdb/pg_ctl
 *     recipe used to verify this issue)
 *   - the "db-migrations" CI job (.github/workflows/ci.yml), which this
 *     issue extends to run `prisma migrate deploy` + this suite, mirroring
 *     the pattern issue #3 already established for verify-constraints.ts.
 */
describe('Rules API (e2e, real Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dbAvailable = true;
  let agent: ReturnType<typeof request.agent>;
  const authUsername = 'rules-e2e-user';
  const authPassword = 'synthetic-rules-password';

  beforeAll(async () => {
    prisma = new PrismaClient();
    try {
      // Fails fast if DATABASE_URL is unreachable or the monitor_rule
      // table doesn't exist yet (migration not applied).
      await prisma.$queryRaw`SELECT 1`;
      await prisma.monitorRule.findFirst();
      await prisma.appUser.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping rules e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` against a real Postgres to execute this suite - see docs/rules-api.md.',
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
    await prisma.appUser.deleteMany({ where: { username: authUsername } });
    await prisma.appUser.create({
      data: {
        username: authUsername,
        displayName: '规则接口测试用户',
        passwordHash: await hash(authPassword, { type: argon2id }),
      },
    });
    agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/auth/login')
      .send({ username: authUsername, password: authPassword })
      .expect(200);
  });

  afterAll(async () => {
    if (dbAvailable) await prisma.appUser.deleteMany({ where: { username: authUsername } });
    if (app) await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Clean slate between tests - monitor_rule has no FK dependents in
    // this suite's scope (monitor_match is issue #5's concern).
    await prisma.monitorRule.deleteMany({});
  });

  /**
   * `it.skip` can't be chosen dynamically here: Jest collects the
   * describe block (and therefore evaluates every `it(...)` call)
   * SYNCHRONOUSLY at file-load time, before `beforeAll` (which is where
   * `dbAvailable` gets its real value) has run - so a `dbAvailable ?
   * it : it.skip` ternary evaluated at collection time would always see
   * the initial `true` default. Instead, every test body itself checks
   * the flag first and returns immediately (still counted as a PASSING
   * test, not a failure) when no DB is available - `run_in_background`/CI
   * log output makes the skip reason visible via the probe test below.
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
        'rules.e2e-spec.ts: all subsequent cases are NO-OPS because no live Postgres was reachable.',
      );
    }
    expect(true).toBe(true);
  });

  itWithDb(
    'full lifecycle: create -> list -> get -> edit (in place) -> disable -> versioned edit',
    async () => {
      const createRes = await agent
        .post('/api/rules')
        .send({ keyword: '肿瘤', level: 'RED', matchField: 'REPORT_TEXT', actorId: 'tester' })
        .expect(201);

      expect(createRes.body.keyword).toBe('肿瘤');
      expect(createRes.body.version).toBe(1);
      const ruleId = createRes.body.id;

      const listRes = await agent.get('/api/rules').query({ keyword: '肿瘤' }).expect(200);
      expect(listRes.body.total).toBe(1);
      expect(listRes.body.items[0].id).toBe(ruleId);

      const getRes = await agent.get(`/api/rules/${ruleId}`).expect(200);
      expect(getRes.body.id).toBe(ruleId);

      // In-place edit: only notes changes (no semantic field touched), so
      // the id stays the same - but `version` still increments, since
      // optimistic locking must be able to detect a second concurrent
      // in-place edit too (see the dedicated version-conflict tests below).
      const editRes = await agent
        .put(`/api/rules/${ruleId}`)
        .send({ version: 1, notes: 'reviewed', actorId: 'editor' })
        .expect(200);
      expect(editRes.body.id).toBe(ruleId);
      expect(editRes.body.version).toBe(2);
      expect(editRes.body.notes).toBe('reviewed');

      // Disable: still in place.
      const disableRes = await agent
        .put(`/api/rules/${ruleId}`)
        .send({ version: 2, isEnabled: false, actorId: 'editor' })
        .expect(200);
      expect(disableRes.body.isEnabled).toBe(false);
      expect(disableRes.body.id).toBe(ruleId);
      expect(disableRes.body.version).toBe(3);

      // Re-enable + change keyword (semantic change) -> new version row.
      const versionedRes = await agent
        .put(`/api/rules/${ruleId}`)
        .send({ version: 3, keyword: '恶性肿瘤', isEnabled: true, actorId: 'editor' })
        .expect(200);
      expect(versionedRes.body.id).not.toBe(ruleId);
      expect(versionedRes.body.version).toBe(4);
      expect(versionedRes.body.ruleGroupId).toBe(ruleId);

      const oldRow = await agent.get(`/api/rules/${ruleId}`).expect(200);
      expect(oldRow.body.isEnabled).toBe(false);
    },
  );

  itWithDb(
    'rejects a duplicate enabled rule with RULE_CONFLICT and a conflictingRuleId',
    async () => {
      const first = await agent
        .post('/api/rules')
        .send({ keyword: 'Ca', level: 'RED', matchField: 'REPORT_TEXT', actorId: 'tester' })
        .expect(201);

      const dupRes = await agent
        .post('/api/rules')
        // Case-insensitive duplicate ("ca" vs "Ca") per issue #4's business rule.
        .send({ keyword: 'ca', level: 'RED', matchField: 'REPORT_TEXT', actorId: 'tester' })
        .expect(409);

      expect(dupRes.body.error.code).toBe('RULE_CONFLICT');
      expect(dupRes.body.error.details.conflictingRuleId).toBe(first.body.id);
      expect(dupRes.body.error.correlationId).toBeDefined();
    },
  );

  itWithDb(
    'returns 409 RULE_VERSION_CONFLICT when retrying a semantic edit with an already-superseded version',
    async () => {
      const created = await agent
        .post('/api/rules')
        .send({ keyword: '腺瘤', level: 'YELLOW', matchField: 'FINDINGS', actorId: 'tester' })
        .expect(201);

      // editor-a's semantic edit lands first - this versions the row (new
      // id, version=2, old row disabled and left at version=1 permanently).
      const editorAResult = await agent
        .put(`/api/rules/${created.body.id}`)
        .send({ version: 1, keyword: '低级别腺瘤', actorId: 'editor-a' })
        .expect(200);
      expect(editorAResult.body.version).toBe(2);

      // editor-b also read version=1 on the original id and tries their own
      // semantic edit against it - must be rejected: the original row is
      // now disabled/superseded, not the current version of this rule.
      const staleRes = await agent
        .put(`/api/rules/${created.body.id}`)
        .send({ version: 1, keyword: '重度不典型增生', actorId: 'editor-b' })
        .expect(409);

      expect(staleRes.body.error.code).toBe('RULE_VERSION_CONFLICT');
    },
  );

  itWithDb(
    'returns 409 RULE_VERSION_CONFLICT for a stale in-place edit too (e.g. two operators both disabling from a stale read)',
    async () => {
      const created = await agent
        .post('/api/rules')
        .send({ keyword: '息肉', level: 'GREEN', matchField: 'FINDINGS', actorId: 'tester' })
        .expect(201);

      // Two operators both read version 1. editor-a's disable lands first -
      // an in-place update (no semantic field changed) that still
      // increments `version` (1 -> 2), specifically so this next call is
      // detectable as stale even though it's also a non-semantic edit.
      await agent
        .put(`/api/rules/${created.body.id}`)
        .send({ version: 1, isEnabled: false, actorId: 'editor-a' })
        .expect(200);

      // editor-b's stale version=1 write must be rejected, not silently
      // applied on top of / undoing editor-a's disable.
      const staleRes = await agent
        .put(`/api/rules/${created.body.id}`)
        .send({ version: 1, notes: 'editor-b, unaware of disable', actorId: 'editor-b' })
        .expect(409);

      expect(staleRes.body.error.code).toBe('RULE_VERSION_CONFLICT');
    },
  );

  itWithDb('rejects an illegal enum value with a 400 and the unified error shape', async () => {
    const res = await agent
      .post('/api/rules')
      .send({ keyword: 'x', level: 'NOT_A_LEVEL', matchField: 'REPORT_TEXT', actorId: 'tester' })
      .expect(400);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toMatch(/level/i);
  });

  itWithDb('rejects a blank keyword with a 400', async () => {
    await agent
      .post('/api/rules')
      .send({ keyword: '   ', level: 'RED', matchField: 'REPORT_TEXT', actorId: 'tester' })
      .expect(400);
  });

  itWithDb('returns 404 RULE_NOT_FOUND for an unknown id', async () => {
    const res = await agent.get('/api/rules/00000000-0000-0000-0000-000000000000').expect(404);
    expect(res.body.error.code).toBe('RULE_NOT_FOUND');
  });

  // --- CSV import -----------------------------------------------------

  itWithDb('import: full success validates and confirms all rows', async () => {
    const csv =
      'keyword,level,matchField,matchMode\n癌,RED,REPORT_TEXT,CONTAINS\n肿瘤,RED,REPORT_TEXT,CONTAINS\n';

    const validateRes = await agent
      .post('/api/rules/import/validate')
      .attach('file', Buffer.from(csv, 'utf8'), 'rules.csv')
      .expect(201);

    expect(validateRes.body.totalRows).toBe(2);
    expect(validateRes.body.validRows).toBe(2);
    expect(validateRes.body.errors).toHaveLength(0);

    const confirmRes = await agent
      .post('/api/rules/import/confirm')
      .send({ importToken: validateRes.body.importToken, actorId: 'importer' })
      .expect(201);

    expect(confirmRes.body.createdCount).toBe(2);

    const listRes = await agent.get('/api/rules').expect(200);
    expect(listRes.body.total).toBe(2);
  });

  itWithDb(
    'import: partial failure reports per-row errors and only valid rows are importable',
    async () => {
      const csv =
        'keyword,level,matchField\n癌,RED,REPORT_TEXT\n,RED,REPORT_TEXT\n肿瘤,BAD_LEVEL,REPORT_TEXT\n';

      const validateRes = await agent
        .post('/api/rules/import/validate')
        .attach('file', Buffer.from(csv, 'utf8'), 'rules.csv')
        .expect(201);

      expect(validateRes.body.totalRows).toBe(3);
      expect(validateRes.body.validRows).toBe(1);
      expect(validateRes.body.errors).toHaveLength(2);

      const confirmRes = await agent
        .post('/api/rules/import/confirm')
        .send({ importToken: validateRes.body.importToken, actorId: 'importer' })
        .expect(201);
      expect(confirmRes.body.createdCount).toBe(1);
    },
  );

  itWithDb(
    'import: duplicate rows within the file are flagged, not silently deduped-and-imported',
    async () => {
      const csv = 'keyword,level,matchField\n癌,RED,REPORT_TEXT\n癌,RED,REPORT_TEXT\n';

      const validateRes = await agent
        .post('/api/rules/import/validate')
        .attach('file', Buffer.from(csv, 'utf8'), 'rules.csv')
        .expect(201);

      expect(validateRes.body.validRows).toBe(1);
      expect(validateRes.body.errors[0].message).toMatch(/duplicate row/);
    },
  );

  itWithDb('import: encoding error (invalid UTF-8) is rejected with a 400', async () => {
    const invalidUtf8 = Buffer.from([0x6b, 0x65, 0x79, 0xff, 0xfe, 0x00, 0x01]);

    const res = await agent
      .post('/api/rules/import/validate')
      .attach('file', invalidUtf8, 'rules.csv')
      .expect(400);

    expect(res.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  itWithDb('import: empty file is rejected with a 400', async () => {
    const res = await agent
      .post('/api/rules/import/validate')
      .attach('file', Buffer.from('', 'utf8'), 'rules.csv')
      .expect(400);

    expect(res.body.error.code).toBe('IMPORT_FILE_INVALID');
  });

  itWithDb('import confirm: rejects an unknown/expired import token', async () => {
    const res = await agent
      .post('/api/rules/import/confirm')
      .send({ importToken: 'does-not-exist', actorId: 'importer' })
      .expect(400);

    expect(res.body.error.code).toBe('IMPORT_TOKEN_INVALID');
  });
});
