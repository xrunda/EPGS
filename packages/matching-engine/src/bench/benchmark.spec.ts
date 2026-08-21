import { matchReport } from '../matcher';
import { generateSyntheticReports, generateSyntheticRules } from './synthetic-reports';

/**
 * This is a recorded-benchmark test, not a strict performance gate: per
 * issue #5, "不需要严苛的性能门槛，只需要有基准记录和数量级合理". It
 * asserts only that 1,000 reports x 20 rules complete within a generous
 * ceiling (never expected to be close in practice) so a severe regression
 * (e.g. an accidental O(n^2) blowup) still fails CI, while day-to-day
 * timing variance on shared CI hardware does not cause flakes.
 */
describe('matchReport performance benchmark', () => {
  it('processes 1,000 synthetic reports x 20 rules within a generous ceiling and logs the timing', () => {
    const reportCount = 1000;
    const ruleCount = 20;
    const reports = generateSyntheticReports(reportCount);
    const rules = generateSyntheticRules(ruleCount);

    const start = process.hrtime.bigint();
    for (const report of reports) {
      matchReport({ ...report, rules });
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    // eslint-disable-next-line no-console
    console.log(
      `[matching-engine benchmark] ${reportCount} reports x ${ruleCount} rules in ${elapsedMs.toFixed(2)}ms ` +
        `(${(elapsedMs / reportCount).toFixed(4)}ms/report)`,
    );

    // Generous ceiling - see BENCHMARK.md for the actual recorded baseline.
    expect(elapsedMs).toBeLessThan(5000);
  });
});
