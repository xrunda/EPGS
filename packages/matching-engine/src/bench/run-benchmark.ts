/**
 * Manual performance benchmark for the matching engine (issue #5
 * acceptance criterion: "1,000 份代表性报告的处理性能达到项目约定基线并
 * 有基准记录"). Not part of the CI-gating test suite - this is a
 * standalone script (`pnpm --filter @epgs/matching-engine run bench`)
 * that prints timing to stdout. See BENCHMARK.md for the recorded
 * baseline result.
 */
import { matchReport } from '../matcher';
import { generateSyntheticReports, generateSyntheticRules } from './synthetic-reports';

function runBenchmark(reportCount: number, ruleCount: number): void {
  const reports = generateSyntheticReports(reportCount);
  const rules = generateSyntheticRules(ruleCount);

  // Warm up (JIT) before timing, so the recorded number reflects steady-state throughput.
  for (const report of reports.slice(0, Math.min(50, reports.length))) {
    matchReport({ ...report, rules });
  }

  const start = process.hrtime.bigint();
  let totalMatches = 0;
  for (const report of reports) {
    const result = matchReport({ ...report, rules });
    totalMatches += result.matchedRules.length;
  }
  const end = process.hrtime.bigint();
  const elapsedMs = Number(end - start) / 1_000_000;

  console.log(`matching-engine benchmark: ${reportCount} reports x ${ruleCount} rules`);
  console.log(`  total time:        ${elapsedMs.toFixed(2)} ms`);
  console.log(`  avg per report:    ${(elapsedMs / reportCount).toFixed(4)} ms`);
  console.log(`  total matchedRule entries produced: ${totalMatches}`);
}

runBenchmark(1000, 20);
