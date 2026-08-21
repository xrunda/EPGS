# matching-engine performance benchmark

Recorded per issue #5 acceptance criterion: "1,000 份代表性报告的处理性能达
到项目约定基线并有基准记录" (no strict performance gate is required — only a
recorded baseline showing the order of magnitude is sane).

## How to reproduce

```bash
pnpm --filter @epgs/matching-engine run bench
```

This runs `src/bench/run-benchmark.ts`, which:

1. Generates 1,000 synthetic (non-patient) report texts via a seeded PRNG
   (`src/bench/synthetic-reports.ts`) — deterministic across runs.
2. Generates a representative 20-rule snapshot covering RED/YELLOW/GREEN
   levels, all three `MatchMode` values in use across the suite (`CONTAINS`),
   and a mix of `FINDINGS` / `IMPRESSION` / `REPORT_TEXT` (ALL) scopes.
3. Warms up the JIT with the first 50 reports, then times a single pass of
   `matchReport()` over all 1,000 reports.

The same 1,000 x 20 workload is also asserted (as a generous, non-flaky
ceiling — not a tight gate) in `src/bench/benchmark.spec.ts`, which runs as
part of `pnpm test` and prints its own timing line to the Jest log.

## Recorded baseline

Environment: local dev machine, Node v24.13.0, single run via
`pnpm --filter @epgs/matching-engine run bench` (three consecutive runs
shown for stability).

| Run | Total time (1,000 reports x 20 rules) | Avg per report |
|---|---|---|
| 1 | 12.81 ms | 0.0128 ms |
| 2 | 13.74 ms | 0.0137 ms |
| 3 | 13.38 ms | 0.0134 ms |

Total `matchedRule` entries produced was identical (2,874) across all runs,
confirming deterministic output for the same synthetic input.

Under `jest` (no manual warmup, ts-jest transform overhead included in the
timed region), the same workload completed in ~41-63 ms
(~0.04-0.06 ms/report) — see the `[matching-engine benchmark]` console line
in `pnpm test` output for `packages/matching-engine`.

**Conclusion**: 1,000 reports x 20 rules complete in well under 100 ms
end-to-end (order of magnitude: tens of milliseconds, i.e. tens of
microseconds per report), comfortably within a reasonable baseline for a
synchronous, in-process pure function with no I/O. `benchmark.spec.ts`
asserts a generous 5,000 ms ceiling so this baseline is regression-checked
by CI without being flaky on shared/slower hardware.
