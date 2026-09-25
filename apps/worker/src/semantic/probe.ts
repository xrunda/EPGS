import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  deriveOccurrences,
  validateMatch,
  ValidateMatchDeps,
  ValidateMatchInput,
} from '@epgs/ai-semantic';
import { AppModule } from '../app.module';
import { buildSemanticModelClient, readSemanticModelSettings } from './semantic-model.factory';

/**
 * Gateway probe for the semantic judge (issue #87), run as
 * `pnpm --filter @epgs/worker run semantic:probe`.
 *
 * WHY THIS EXISTS: the owner's answer on the hospital's own model gateway was
 * "暂时不知道是否是 OpenAI 兼容". The judge's env seam
 * (SEMANTIC_MODEL_API_STYLE) can describe a different protocol, but before
 * anyone commits to one they need to know what the gateway actually does with
 * an OpenAI-chat request. This sends a handful of SYNTHETIC exam sentences -
 * written for this file, no patient data anywhere in it - through the real
 * client and the real task, and prints what came back.
 *
 * DELIBERATELY RUNNABLE WITH THE JUDGE OFF. It does not go through
 * SemanticJudgeService, does not touch the database, and does not need
 * SEMANTIC_JUDGE_ENABLED=true - its whole purpose is to inform the decision to
 * switch the judge on. It needs only SEMANTIC_MODEL_BASE_URL and
 * SEMANTIC_MODEL_NAME (optional SEMANTIC_MODEL_API_KEY and
 * SEMANTIC_MODEL_API_STYLE).
 *
 * TWO KINDS OF ANSWER, and the difference matters:
 *
 *   Did the gateway work at all? A contract failure - wrong envelope shape,
 *   no JSON, an HTTP error, a timeout - shows up as `outcome: ERROR` with a
 *   machine code, and makes this command exit 1. That is the deployment being
 *   unusable, and it is a hard failure.
 *
 *   Did the model read the sentences correctly? Each case prints what the
 *   model said and what was expected. A disagreement is NOT an exit code: it
 *   is an evaluation result, and a human decides whether that model is good
 *   enough. Pass --strict to make disagreements fail too, for a smoke test.
 *
 * The expectations are exactly issue #87's acceptance samples, including the
 * one that matters most: a report that negates the keyword in one clause and
 * documents it in the next must NOT be filtered. A model that gets that wrong
 * would drop a real finding, so the probe says so loudly.
 *
 * The printed `reason` is the model's own sentence. Safe HERE and only here -
 * the input is synthetic - whereas the judge's own logs deliberately never
 * print it, because in production it may quote the report.
 */

/** One synthetic case. `fieldText` is written for this file; no patient data. */
interface ProbeCase {
  name: string;
  fieldText: string;
  expectFiltered: boolean;
  /** Short note shown when the case disagrees, to help interpret a failure. */
  note: string;
}

const PROBE_INTENT =
  '本次检查明确发现或疑似存在溃疡性病变；明确否定、单纯既往史不作为本次有效命中。';

const PROBE_KEYWORD = '溃疡';
const PROBE_MATCH_MODE = 'CONTAINS';

const PROBE_CASES: readonly ProbeCase[] = [
  {
    name: '阳性：胃窦见巨大溃疡',
    fieldText: '检查所见：胃窦部可见一大小约1.0cm溃疡，表面覆白苔，周围黏膜充血水肿。',
    expectFiltered: false,
    note: 'expect 保持命中 (PRESENT)',
  },
  {
    name: '否定：十二指肠球部未见明显溃疡',
    fieldText: '检查所见：十二指肠球部未见明显溃疡，黏膜光滑，未见糜烂。',
    expectFiltered: true,
    note: 'expect 过滤 (NEGATED + HIGH)',
  },
  {
    name: '既往史：既往有胃溃疡病史',
    fieldText: '既往有胃溃疡病史，本次检查所见：胃窦黏膜光滑，未见异常。',
    expectFiltered: true,
    note: 'expect 过滤 (HISTORY + HIGH + 意图排除既往史)',
  },
  {
    name: '疑似：考虑溃疡可能',
    fieldText: '检查所见：胃角黏膜粗糙不平，考虑溃疡可能，建议取活检进一步明确。',
    expectFiltered: false,
    note: 'expect 保持命中 (SUSPECTED - 疑似不算否定)',
  },
  {
    name: '关键场景：先否定后阳性（同一关键词出现两次）',
    fieldText: '检查所见：十二指肠球部未见明显溃疡；胃窦部见巨大溃疡，表面覆白苔。',
    expectFiltered: false,
    note: 'expect 必须保持命中 - 报告确实记录了溃疡，过滤即为漏报',
  },
];

interface CaseOutcome {
  case: ProbeCase;
  /** True when the call/contract side worked (outcome OK). */
  callOk: boolean;
  /** True when the decision matched the expectation. */
  asExpected: boolean;
}

async function main(): Promise<void> {
  const strict = process.argv.slice(2).includes('--strict');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const config = app.get(ConfigService);
    const { settings, missing } = readSemanticModelSettings(config);
    if (settings === null) {
      throw new Error(
        `semantic:probe is not configured - set ${missing.join(', ')} ` +
          '(SEMANTIC_JUDGE_ENABLED is NOT required for the probe)',
      );
    }

    const deps: ValidateMatchDeps = {
      client: buildSemanticModelClient(settings),
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      maxTokens: settings.maxTokens,
      contextCharBudget: settings.contextCharBudget,
    };

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        message: 'semantic:probe - synthetic text only, no patient data',
        apiStyle: settings.apiStyle,
        model: settings.model,
        timeoutMs: deps.timeoutMs,
        maxTokens: deps.maxTokens,
        contextCharBudget: deps.contextCharBudget,
        cases: PROBE_CASES.length,
      }),
    );

    const outcomes: CaseOutcome[] = [];
    for (const probeCase of PROBE_CASES) {
      // Same anchor derivation the judge uses, so the probe exercises the real
      // context selection rather than a hand-made offset that cannot occur.
      const occurrences = deriveOccurrences(
        probeCase.fieldText,
        PROBE_KEYWORD,
        PROBE_MATCH_MODE,
        false,
      );
      const anchor = occurrences[0] ?? { start: 0, end: 0 };

      const input: ValidateMatchInput = {
        keyword: PROBE_KEYWORD,
        semanticIntent: PROBE_INTENT,
        fieldText: probeCase.fieldText,
        matchStart: anchor.start,
        matchEnd: anchor.end,
        matchMode: PROBE_MATCH_MODE,
        matchField: 'FINDINGS',
        reportVersion: 1,
      };

      const result = await validateMatch(input, deps);
      const callOk = result.outcome === 'OK';
      const asExpected = callOk && result.decision.filtered === probeCase.expectFiltered;

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          case: probeCase.name,
          expectation: probeCase.note,
          outcome: result.outcome,
          semanticStatus: result.verdict?.semanticStatus ?? null,
          confidence: result.verdict?.confidence ?? null,
          matched: result.verdict?.matched ?? null,
          intentExcludesHistory: result.verdict?.intentExcludesHistory ?? null,
          evidenceVerified: result.evidence !== null,
          filtered: result.decision.filtered,
          decisionReason: result.decision.reason,
          reason: result.verdict?.reason ?? null,
          error: result.error,
          latencyMs: result.latencyMs,
          modelVersion: result.modelVersion,
          asExpected,
        }),
      );

      outcomes.push({ case: probeCase, callOk, asExpected });
    }

    const contractFailures = outcomes.filter((outcome) => !outcome.callOk);
    const disagreements = outcomes.filter((outcome) => outcome.callOk && !outcome.asExpected);

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        message: 'semantic:probe summary',
        callsOk: outcomes.length - contractFailures.length,
        callsFailed: contractFailures.length,
        expectationsMatched: outcomes.filter((outcome) => outcome.asExpected).length,
        expectationsTotal: outcomes.length,
        failedCases: contractFailures.map((outcome) => outcome.case.name),
        disagreedCases: disagreements.map((outcome) => outcome.case.name),
      }),
    );

    if (contractFailures.length > 0) {
      // The gateway could not serve the request at all - unusable until fixed.
      // Check SEMANTIC_MODEL_API_STYLE / the gateway's own docs: a different
      // response envelope is the most likely cause.
      throw new Error(
        `${contractFailures.length} of ${outcomes.length} probe call(s) failed: ` +
          contractFailures.map((outcome) => outcome.case.name).join('; '),
      );
    }
    if (strict && disagreements.length > 0) {
      throw new Error(
        `--strict: ${disagreements.length} case(s) were judged differently than expected: ` +
          disagreements.map((outcome) => outcome.case.name).join('; '),
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'fatal',
      message: `semantic:probe failed to run: ${err instanceof Error ? err.message : 'unknown error'}`,
    }),
  );
  process.exitCode = 1;
});
