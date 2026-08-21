import { Logger } from '@nestjs/common';
import { PrismaClient, SyncJobStatus, MonitorLevel, MatchField, MatchMode } from '@prisma/client';
import { FetchReportsParams, FetchReportsResult, PacsReportDto, PacsReportStatus } from '@epgs/shared-types';
import { PacsRisAdapter } from '../src/pacs-adapter/pacs-ris-adapter.interface';
import { FixturePacsRisAdapter } from '../src/pacs-adapter/fixture-pacs-ris-adapter';
import { runSync, SyncRunnerOptions } from '../src/sync/sync-runner';
import { SYNC_JOB_NAME } from '../src/sync/sync-cursor';

/**
 * Full-stack e2e test for issue #6's incremental sync job against a REAL
 * Postgres instance with the monitor_* migration applied (issue #3's
 * schema). Mirrors apps/api/test/rules.e2e-spec.ts's pattern: probes DB
 * connectivity in beforeAll, and every test becomes a no-op (still
 * reported as PASSING, not skipped/failed) if DATABASE_URL doesn't point
 * at a reachable, migrated Postgres - so `pnpm run test` stays DB-free
 * per issue #1's CI design, while the "db-migrations" CI job (and local
 * verification, see docs/sync-job.md) runs this suite for real.
 *
 * Covers the issue's required test scenarios: first full window, normal
 * incremental, same-timestamp multi-record, duplicate batch re-run
 * (idempotency), process-interruption recovery (FAILED run doesn't
 * advance the cursor), late-arriving updates via the look-back window,
 * source unavailable (retries then FAILED without cursor loss), single
 * record parse failure not blocking the batch, and two workers running
 * concurrently without duplicating records.
 */
describe('Sync job (e2e, real Postgres)', () => {
  let prisma: PrismaClient;
  let dbAvailable = true;
  const silentLogger = new Logger('sync.e2e-spec');

  const baseOptions: SyncRunnerOptions = {
    pageSize: 200,
    lookbackMinutes: 10,
    firstRunLookbackMinutes: 60 * 24 * 30, // first-run window big enough to cover the fixture's fixed Aug 2026 dates
    maxRetries: 3,
    retryBaseDelayMs: 1,
    sleep: async () => undefined,
  };

  beforeAll(async () => {
    jest.spyOn(silentLogger, 'log').mockImplementation(() => undefined);
    jest.spyOn(silentLogger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(silentLogger, 'error').mockImplementation(() => undefined);
    jest.spyOn(silentLogger, 'debug').mockImplementation(() => undefined);

    prisma = new PrismaClient();
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.monitorRecord.findFirst();
      await prisma.syncJobLog.findFirst();
    } catch (err) {
      dbAvailable = false;
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping sync e2e suite: no reachable/migrated Postgres at DATABASE_URL (${(err as Error).message}). ` +
          'Run `prisma migrate deploy` (from apps/api) against a real Postgres to execute this suite.',
      );
    }
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  beforeEach(async () => {
    if (!dbAvailable) return;
    // Clean slate between tests, respecting FK order (matches/actions ->
    // records; rules are independent).
    await prisma.monitorMatch.deleteMany({});
    await prisma.monitorAction.deleteMany({});
    await prisma.monitorRecord.deleteMany({});
    await prisma.syncJobLog.deleteMany({});
    await prisma.monitorRule.deleteMany({});
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
      console.warn('sync.e2e-spec.ts: all subsequent cases are NO-OPS because no live Postgres was reachable.');
    }
    expect(true).toBe(true);
  });

  async function seedRedRule(): Promise<void> {
    await prisma.monitorRule.create({
      data: {
        keyword: '癌',
        level: MonitorLevel.RED,
        matchField: MatchField.REPORT_TEXT,
        matchMode: MatchMode.CONTAINS,
        isEnabled: true,
        version: 1,
        ruleGroupId: '00000000-0000-0000-0000-0000000000a1',
        createdBy: 'test',
        updatedBy: 'test',
      },
    });
  }

  itWithDb('first full window: syncing the fixture dataset from scratch creates MonitorRecord + SyncJobLog rows', async () => {
    await seedRedRule();
    const adapter = new FixturePacsRisAdapter();
    const now = new Date('2026-08-21T00:00:00Z'); // well after the fixture's fixed Aug 1-2 2026 dates

    const summary = await runSync(prisma, adapter, now, baseOptions, silentLogger);

    expect(summary.status).toBe(SyncJobStatus.SUCCEEDED);
    expect(summary.readCount).toBe(8); // fixture has 8 records
    expect(summary.successCount).toBe(8);
    expect(summary.failureCount).toBe(0);

    const records = await prisma.monitorRecord.findMany();
    expect(records).toHaveLength(8);

    const jobLogs = await prisma.syncJobLog.findMany({ where: { jobName: SYNC_JOB_NAME } });
    expect(jobLogs).toHaveLength(1);
    expect(jobLogs[0].status).toBe(SyncJobStatus.SUCCEEDED);
    expect(jobLogs[0].cursorEnd).toBeTruthy();
  });

  itWithDb('re-running the exact same batch twice does not increase MonitorRecord/MonitorMatch counts (idempotency)', async () => {
    await seedRedRule();
    const adapter = new FixturePacsRisAdapter();
    const now = new Date('2026-08-21T00:00:00Z');

    await runSync(prisma, adapter, now, baseOptions, silentLogger);
    const recordCountAfterFirst = await prisma.monitorRecord.count();
    const matchCountAfterFirst = await prisma.monitorMatch.count();

    // Re-run with the SAME `now` and a lookback big enough to re-read the
    // identical window again (simulating a duplicate batch execution).
    await runSync(prisma, adapter, new Date(now.getTime() + 1000), { ...baseOptions, lookbackMinutes: 60 * 24 * 30 }, silentLogger);

    const recordCountAfterSecond = await prisma.monitorRecord.count();
    const matchCountAfterSecond = await prisma.monitorMatch.count();

    expect(recordCountAfterSecond).toBe(recordCountAfterFirst);
    expect(matchCountAfterSecond).toBe(matchCountAfterFirst);
  });

  itWithDb('normal incremental sync: a second run only picks up newly-updated records after the first cursor', async () => {
    const items: PacsReportDto[] = [
      makeReport({ reportId: 'INC-1', studyAccessionNo: 'ACC-INC-1', sourceUpdatedAt: new Date('2026-08-21T01:00:00Z') }),
    ];
    const adapter = new StubAdapter(items);
    const firstNow = new Date('2026-08-21T01:05:00Z');
    await runSync(prisma, adapter, firstNow, { ...baseOptions, lookbackMinutes: 0 }, silentLogger);
    expect(await prisma.monitorRecord.count()).toBe(1);

    // Second run: adapter now also has a NEW record with a later
    // sourceUpdatedAt. A correctly-resolved `since` (from the first
    // run's cursorEnd) means only the new record is "read" in spirit,
    // though this stub returns everything in range regardless - the
    // assertion that matters is the record count growing by exactly one
    // new natural key, not a duplicate of INC-1.
    items.push(
      makeReport({ reportId: 'INC-2', studyAccessionNo: 'ACC-INC-2', sourceUpdatedAt: new Date('2026-08-21T01:10:00Z') }),
    );
    const secondNow = new Date('2026-08-21T01:15:00Z');
    const summary = await runSync(prisma, adapter, secondNow, { ...baseOptions, lookbackMinutes: 0 }, silentLogger);

    expect(summary.status).toBe(SyncJobStatus.SUCCEEDED);
    const records = await prisma.monitorRecord.findMany({ orderBy: { reportId: 'asc' } });
    expect(records.map((r) => r.reportId)).toEqual(['INC-1', 'INC-2']);
  });

  itWithDb('same sourceUpdatedAt timestamp on multiple records: all are processed without collision', async () => {
    const sameTs = new Date('2026-08-21T02:00:00Z');
    const items: PacsReportDto[] = [
      makeReport({ reportId: 'TS-A', studyAccessionNo: 'ACC-TS-A', sourceUpdatedAt: sameTs }),
      makeReport({ reportId: 'TS-B', studyAccessionNo: 'ACC-TS-B', sourceUpdatedAt: sameTs }),
      makeReport({ reportId: 'TS-C', studyAccessionNo: 'ACC-TS-C', sourceUpdatedAt: sameTs }),
    ];
    const adapter = new StubAdapter(items);
    const summary = await runSync(prisma, adapter, new Date('2026-08-21T02:05:00Z'), baseOptions, silentLogger);

    expect(summary.successCount).toBe(3);
    expect(await prisma.monitorRecord.count()).toBe(3);
  });

  itWithDb('a report with an amended sourceUpdatedAt (content change, same natural key) re-triggers matching', async () => {
    await seedRedRule();
    const reportId = 'AMEND-1';
    const accession = 'ACC-AMEND-1';
    const adapter = new StubAdapter([
      makeReport({
        reportId,
        studyAccessionNo: accession,
        sourceUpdatedAt: new Date('2026-08-21T03:00:00Z'),
        describeText: '未见明显异常',
        diagnoseText: '未见明显异常',
      }),
    ]);
    await runSync(prisma, adapter, new Date('2026-08-21T03:05:00Z'), { ...baseOptions, lookbackMinutes: 0 }, silentLogger);
    let record = await prisma.monitorRecord.findFirst({ where: { reportId } });
    expect(record?.currentLevel).toBe(MonitorLevel.UNCLASSIFIED);

    // Content corrected under the SAME reportId/version, later sourceUpdatedAt, now contains the RED keyword.
    adapter.items[0] = makeReport({
      reportId,
      studyAccessionNo: accession,
      sourceUpdatedAt: new Date('2026-08-21T03:10:00Z'),
      describeText: '胃体见癌灶',
      diagnoseText: '胃癌',
    });
    await runSync(prisma, adapter, new Date('2026-08-21T03:15:00Z'), { ...baseOptions, lookbackMinutes: 0 }, silentLogger);

    record = await prisma.monitorRecord.findFirst({ where: { reportId } });
    expect(record?.currentLevel).toBe(MonitorLevel.RED);
    expect(await prisma.monitorRecord.count({ where: { reportId } })).toBe(1); // still one row, not a duplicate
    const matches = await prisma.monitorMatch.findMany({ where: { record: { reportId } } });
    expect(matches.length).toBeGreaterThan(0);
  });

  itWithDb('a late-arriving update within the look-back window is picked up even after the previous cursor advanced past it', async () => {
    const first = makeReport({ reportId: 'LATE-1', studyAccessionNo: 'ACC-LATE-1', sourceUpdatedAt: new Date('2026-08-21T04:00:00Z') });
    const adapter = new StubAdapter([first]);
    await runSync(prisma, adapter, new Date('2026-08-21T04:05:00Z'), { ...baseOptions, lookbackMinutes: 0 }, silentLogger);

    // A second, distinct report with an EARLIER sourceUpdatedAt than the
    // committed cursor arrives late (e.g. clock skew / delayed write on
    // the source side). Without a look-back window this would be
    // skipped because the next run's `since` already moved past it.
    const late = makeReport({ reportId: 'LATE-2', studyAccessionNo: 'ACC-LATE-2', sourceUpdatedAt: new Date('2026-08-21T03:59:00Z') });
    adapter.items.push(late);

    const summary = await runSync(prisma, adapter, new Date('2026-08-21T04:10:00Z'), { ...baseOptions, lookbackMinutes: 10 }, silentLogger);
    expect(summary.status).toBe(SyncJobStatus.SUCCEEDED);
    const record = await prisma.monitorRecord.findFirst({ where: { reportId: 'LATE-2' } });
    expect(record).not.toBeNull();
  });

  itWithDb('process interruption: a FAILED run does not advance the cursor past unprocessed data', async () => {
    const items = [
      makeReport({ reportId: 'INT-1', studyAccessionNo: 'ACC-INT-1', sourceUpdatedAt: new Date('2026-08-21T05:00:00Z') }),
    ];
    const failingAdapter: PacsRisAdapter = {
      fetchReports: jest.fn().mockRejectedValue(nonRetryableAuthError()),
    };
    const now = new Date('2026-08-21T05:05:00Z');
    const summary = await runSync(prisma, failingAdapter, now, baseOptions, silentLogger);

    expect(summary.status).toBe(SyncJobStatus.FAILED);
    expect(summary.cursorEnd).toBeNull(); // nothing committed
    expect(await prisma.monitorRecord.count()).toBe(0);

    // Recovery run with a working adapter: must still read from the
    // ORIGINAL `since` (the failed run's cursorEnd was never set), so
    // the not-yet-synced record is not skipped.
    const workingAdapter = new StubAdapter(items);
    const recoverySummary = await runSync(prisma, workingAdapter, new Date(now.getTime() + 60_000), baseOptions, silentLogger);
    expect(recoverySummary.status).toBe(SyncJobStatus.SUCCEEDED);
    expect(await prisma.monitorRecord.count()).toBe(1);
  });

  itWithDb('source unavailable (503-style transient error): retries then marks FAILED without losing the cursor position', async () => {
    let calls = 0;
    const flakyAdapter: PacsRisAdapter = {
      fetchReports: jest.fn().mockImplementation(async () => {
        calls += 1;
        throw transientError();
      }),
    };
    const summary = await runSync(prisma, flakyAdapter, new Date('2026-08-21T06:00:00Z'), { ...baseOptions, maxRetries: 2 }, silentLogger);

    expect(summary.status).toBe(SyncJobStatus.FAILED);
    // initial attempt + 2 retries = 3 calls
    expect(calls).toBe(3);
    expect(summary.cursorEnd).toBeNull();
  });

  itWithDb('a single malformed/failing record does not block the rest of the batch', async () => {
    await seedRedRule();
    const good1 = makeReport({ reportId: 'BAD-BATCH-1', studyAccessionNo: 'ACC-BAD-1', sourceUpdatedAt: new Date('2026-08-21T07:00:00Z') });
    const good2 = makeReport({ reportId: 'BAD-BATCH-3', studyAccessionNo: 'ACC-BAD-3', sourceUpdatedAt: new Date('2026-08-21T07:02:00Z') });

    // Force a genuine per-record failure at the Prisma write layer: an
    // Invalid Date (NaN epoch) in a Timestamptz-bound field. Note the
    // matching-engine (issue #5) deliberately treats a malformed REGEX
    // rule as "matches nothing" rather than throwing (see
    // packages/matching-engine/src/strategies/regex-strategy.ts) - that
    // is a correct, already-established design decision (one bad RULE
    // must not crash matching for every report), so it cannot be used
    // here to simulate a per-REPORT failure. An unparseable timestamp
    // reaching the adapter boundary is the realistic "single bad
    // record" case this acceptance criterion is about.
    const bad = makeReport({
      reportId: 'BAD-BATCH-2',
      studyAccessionNo: 'ACC-BAD-2',
      sourceUpdatedAt: new Date('2026-08-21T07:01:00Z'),
      examTime: new Date('not-a-valid-date'),
    });

    const adapter = new StubAdapter([good1, bad, good2]);
    const summary = await runSync(prisma, adapter, new Date('2026-08-21T07:05:00Z'), baseOptions, silentLogger);

    expect(summary.readCount).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.status).toBe(SyncJobStatus.PARTIAL);

    const goodRecords = await prisma.monitorRecord.findMany({
      where: { reportId: { in: ['BAD-BATCH-1', 'BAD-BATCH-3'] } },
    });
    expect(goodRecords).toHaveLength(2);
    const badRecord = await prisma.monitorRecord.findFirst({ where: { reportId: 'BAD-BATCH-2' } });
    expect(badRecord).toBeNull();

    const jobLog = await prisma.syncJobLog.findFirst({ orderBy: { startedAt: 'desc' } });
    expect(jobLog?.errorSummary).toBeTruthy();
    // error summary must reference only source identifiers, never patient name/inpatient number
    expect(jobLog?.errorSummary).not.toContain('测试患者');
  });

  itWithDb('two workers running concurrently against the same batch do not create duplicate records', async () => {
    await seedRedRule();
    const items = [
      makeReport({ reportId: 'CONC-1', studyAccessionNo: 'ACC-CONC-1', sourceUpdatedAt: new Date('2026-08-21T08:00:00Z'), describeText: '胃体见癌灶', diagnoseText: '胃癌' }),
      makeReport({ reportId: 'CONC-2', studyAccessionNo: 'ACC-CONC-2', sourceUpdatedAt: new Date('2026-08-21T08:01:00Z') }),
    ];
    const adapterA = new StubAdapter([...items]);
    const adapterB = new StubAdapter([...items]);
    const now = new Date('2026-08-21T08:05:00Z');

    const [summaryA, summaryB] = await Promise.all([
      runSync(prisma, adapterA, now, baseOptions, silentLogger),
      runSync(prisma, adapterB, now, baseOptions, silentLogger),
    ]);

    expect([summaryA.status, summaryB.status]).toEqual(
      expect.arrayContaining([expect.stringMatching(/SUCCEEDED|PARTIAL/)]),
    );

    const records = await prisma.monitorRecord.findMany();
    expect(records).toHaveLength(2); // no duplicates despite two concurrent runs

    const matches = await prisma.monitorMatch.findMany();
    // CONC-1's "癌" keyword legitimately matches in BOTH FINDINGS
    // (describeText: "胃体见癌灶") and IMPRESSION (diagnoseText: "胃癌") -
    // that's 2 distinct, correct MatchedRule entries per issue #5's
    // "REPORT_TEXT checks both fields" contract, not a duplication bug.
    // The race-safety assertion is that this stays at exactly 2 (one set
    // of matches) rather than 4 (each concurrent worker writing its own
    // copy) - see upsertReportWithConcurrencyRetry's doc comment in
    // sync-runner.ts for why a single winner is guaranteed here.
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.matchedField))).toEqual(new Set(['FINDINGS', 'IMPRESSION']));

    // Two SyncJobLog rows are expected (one per concurrent run) - that's
    // fine, they're just audit rows; what matters is no duplicate
    // MonitorRecord/MonitorMatch data.
    const jobLogs = await prisma.syncJobLog.count();
    expect(jobLogs).toBe(2);
  });
});

// --- test helpers ----------------------------------------------------------

function makeReport(overrides: Partial<PacsReportDto> = {}): PacsReportDto {
  return {
    sourceRecordId: 'RPT-DEFAULT',
    patientRegistrationNo: 'IP-TEST-0001',
    patientTypeCode: 'I',
    patientTypeName: null,
    examDate: '2026-08-20',
    examTimeText: '00:00:00',
    reportContent: '所见大致正常',
    diagnosis: '未见明显异常',
    patientId: 'PAT-TEST-0001',
    inpatientNo: 'IP-TEST-0001',
    patientName: '测试患者',
    sex: 'M',
    age: 50,
    department: '消化内科',
    bedNo: '1',
    studyAccessionNo: 'ACC-DEFAULT',
    examItem: '胃镜检查',
    examTime: new Date('2026-08-20T00:00:00Z'),
    reportId: 'RPT-DEFAULT',
    reportStatus: PacsReportStatus.FINAL_REVIEWED,
    rawStatusCode: 'FINAL',
    reportSavedAt: new Date('2026-08-20T00:10:00Z'),
    reportSubmittedAt: new Date('2026-08-20T00:20:00Z'),
    reportReviewedAt: new Date('2026-08-20T00:30:00Z'),
    describeText: '所见大致正常',
    diagnoseText: '未见明显异常',
    sourceUpdatedAt: new Date('2026-08-20T00:30:05Z'),
    ...overrides,
  };
}
/** Simple in-memory adapter returning all `items` whose sourceUpdatedAt falls in [since, until) in one page - enough for these targeted scenario tests without re-implementing FixturePacsRisAdapter's fuller pagination. */
class StubAdapter implements PacsRisAdapter {
  constructor(public items: PacsReportDto[]) {}

  async fetchReports(params: FetchReportsParams): Promise<FetchReportsResult> {
    const until = params.until ?? new Date();
    const filtered = this.items.filter((i) => i.sourceUpdatedAt >= params.since && i.sourceUpdatedAt < until);
    return { items: filtered, nextCursor: undefined };
  }
}

function nonRetryableAuthError(): Error {
  const err = new Error('PACS/RIS gateway rejected request: 401 UNAUTHENTICATED');
  err.name = 'PacsHttpAuthError';
  return err;
}

function transientError(): Error {
  const err = new Error('PACS/RIS gateway transient error: 503 DATA_SOURCE_UNAVAILABLE');
  err.name = 'PacsHttpTransientError';
  return err;
}
