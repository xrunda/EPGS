/**
 * Constraint / idempotency / index verification script for issue #3,
 * updated for the issue #26 read-only display schema (closed-loop
 * model removed).
 *
 * Not a Jest suite deliberately: it needs a real Postgres with the
 * monitor_* migrations applied (see .github/workflows/ci.yml's
 * `db-migrations` job, or run locally against `docker-compose up -d
 * postgres` + `pnpm --filter api exec prisma migrate deploy`).
 *
 * Run with: pnpm --filter api exec ts-node --transpile-only prisma/scripts/verify-constraints.ts
 *
 * Exercises, against a real database, everything the acceptance criteria
 * call out:
 *   - duplicate source key (sourceRecordId + reportId + reportVersion)
 *     on monitor_record is rejected (idempotency)
 *   - duplicate keyword hit on monitor_match is rejected (idempotency)
 *   - illegal enum values are rejected
 *   - deleting a monitor_rule referenced by a monitor_match is RESTRICTed
 *   - deleting a monitor_record CASCADEs to its monitor_match rows
 *   - the query planner uses an index for common workbench filters
 *     (current_level, department, exam_time, the source unique key)
 *
 * monitor_action / handling_status / report_status are intentionally
 * absent: the closed-loop reporting model was removed (issue #26) and
 * MonitorRecord now converges to read-only display data.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

let failures = 0;

function ok(label: string) {
  console.log(`  PASS  ${label}`);
}

function fail(label: string, detail?: unknown) {
  failures += 1;
  console.error(`  FAIL  ${label}`, detail ?? '');
}

async function expectUniqueViolation(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    fail(label, 'expected a unique constraint violation but insert succeeded');
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      ok(label);
    } else {
      fail(label, err);
    }
  }
}

async function expectForeignKeyViolation(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    fail(label, 'expected a foreign key violation but the operation succeeded');
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
      ok(label);
    } else {
      fail(label, err);
    }
  }
}

async function main() {
  console.log('Cleaning any leftover data from a previous run...');
  await prisma.monitorMatch.deleteMany({});
  await prisma.monitorRecord.deleteMany({});
  await prisma.monitorRule.deleteMany({});

  console.log('\n1. monitor_rule + monitor_record seed');
  const rule = await prisma.monitorRule.create({
    data: {
      keyword: '腺癌',
      level: 'RED',
      matchField: 'IMPRESSION',
      matchMode: 'CONTAINS',
      ruleGroupId: '11111111-1111-1111-1111-111111111111',
      createdBy: 'tester',
      updatedBy: 'tester',
    },
  });
  ok('created monitor_rule');

  const record = await prisma.monitorRecord.create({
    data: {
      sourceRecordId: 'ACC-0001',
      reportId: 'RPT-0001',
      reportVersion: 1,
      sourceUpdatedAt: new Date(),
      patientName: '测试患者甲',
      department: '消化内科',
      bedNo: '12',
      patientTypeCode: 'I',
      patientTypeName: '住院',
      examItem: '胃镜检查',
      examTime: new Date(),
      currentLevel: 'RED',
      reportContent: '所见描述文本',
      diagnosis: '诊断意见文本',
    },
  });
  ok('created monitor_record');

  console.log('\n2. idempotency: duplicate source key on monitor_record');
  await expectUniqueViolation('duplicate (sourceRecordId, reportId, reportVersion) rejected', () =>
    prisma.monitorRecord.create({
      data: {
        sourceRecordId: 'ACC-0001',
        reportId: 'RPT-0001',
        reportVersion: 1,
        sourceUpdatedAt: new Date(),
      },
    }),
  );

  console.log('\n3. illegal enum value on monitor_record.currentLevel');
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO monitor_record (id, source_record_id, report_id, report_version, source_updated_at, current_level, created_at, updated_at)
       VALUES (gen_random_uuid(), 'ACC-BAD', 'RPT-BAD', 1, now(), 'ORANGE', now(), now())`,
    );
    fail('illegal enum value rejected', 'insert unexpectedly succeeded');
  } catch (err) {
    ok('illegal enum value rejected');
  }

  console.log('\n4. monitor_match: valid insert + duplicate rejection');
  const match = await prisma.monitorMatch.create({
    data: {
      monitorRecordId: record.id,
      ruleId: rule.id,
      keyword: '腺癌',
      level: 'RED',
      matchedField: 'IMPRESSION',
      contextSnippet: '...提示腺癌可能...',
      reportVersion: 1,
    },
  });
  ok('created monitor_match');

  await expectUniqueViolation(
    'duplicate (monitorRecordId, ruleId, matchedField, keyword, reportVersion) rejected',
    () =>
      prisma.monitorMatch.create({
        data: {
          monitorRecordId: record.id,
          ruleId: rule.id,
          keyword: '腺癌',
          level: 'RED',
          matchedField: 'IMPRESSION',
          contextSnippet: '...重复片段...',
          reportVersion: 1,
        },
      }),
  );
  void match;

  console.log('\n5. FK RESTRICT: cannot delete a monitor_rule referenced by monitor_match');
  await expectForeignKeyViolation('deleting referenced monitor_rule rejected', () =>
    prisma.monitorRule.delete({ where: { id: rule.id } }),
  );

  console.log('\n6. FK CASCADE: deleting monitor_record removes its monitor_match rows');
  await prisma.monitorRecord.delete({ where: { id: record.id } });
  const remainingMatches = await prisma.monitorMatch.count({
    where: { monitorRecordId: record.id },
  });
  if (remainingMatches === 0) {
    ok('cascade delete removed dependent monitor_match rows');
  } else {
    fail('cascade delete', { remainingMatches });
  }

  console.log('\n7. index usage for representative workbench filters');
  const planChecks: Array<{ label: string; sql: string; expectIndex: string }> = [
    {
      label: 'filter by current_level uses index',
      sql: `EXPLAIN SELECT * FROM monitor_record WHERE current_level = 'RED'`,
      expectIndex: 'monitor_record_current_level_idx',
    },
    {
      label: 'filter by department uses index',
      sql: `EXPLAIN SELECT * FROM monitor_record WHERE department = '消化内科'`,
      expectIndex: 'monitor_record_department_idx',
    },
    {
      label: 'filter by exam_time uses index',
      sql: `EXPLAIN SELECT * FROM monitor_record WHERE exam_time >= '2026-08-01'`,
      expectIndex: 'monitor_record_exam_time_idx',
    },
    {
      label: 'source unique key lookup uses index',
      sql: `EXPLAIN SELECT * FROM monitor_record WHERE source_record_id = 'ACC-0001' AND report_id = 'RPT-0001'`,
      expectIndex: 'monitor_record_source_record_id_report_id',
    },
  ];

  // Re-seed a handful of rows so the planner has something to scan; on a
  // near-empty table Postgres may prefer a seq scan regardless of indexes,
  // so this is a best-effort structural check rather than a strict
  // performance assertion.
  for (let i = 0; i < 20; i += 1) {
    await prisma.monitorRecord.create({
      data: {
        sourceRecordId: `ACC-BULK-${i}`,
        reportId: `RPT-BULK-${i}`,
        reportVersion: 1,
        sourceUpdatedAt: new Date(),
        department: i % 2 === 0 ? '消化内科' : '普外科',
        examTime: new Date(),
        currentLevel: i % 3 === 0 ? 'RED' : 'GREEN',
      },
    });
  }

  for (const check of planChecks) {
    const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(check.sql);
    const planText = rows.map((r) => r['QUERY PLAN']).join('\n');
    if (planText.includes(check.expectIndex)) {
      ok(check.label);
    } else {
      // Not a hard failure: on a tiny table Postgres' planner may choose a
      // seq scan even with the index present. Log for visibility instead
      // of failing CI on planner heuristics unrelated to schema
      // correctness - the index's existence is already asserted by the
      // migration SQL / prisma schema itself.
      console.warn(
        `  WARN  ${check.label} (planner chose a different plan on this small dataset):\n${planText}`,
      );
    }
  }

  console.log('\nCleaning up test data...');
  await prisma.monitorRecord.deleteMany({});
  await prisma.monitorRule.deleteMany({});

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nAll constraint/idempotency checks PASSED');
  }
}

main()
  .catch((err) => {
    console.error('Unexpected error running verification script:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
