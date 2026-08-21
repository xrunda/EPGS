import { matchReport } from './matcher';
import { buildInput, buildRule } from './test-fixtures';
import type { MatchInput } from './types';

describe('matchReport', () => {
  // -------------------------------------------------------------------
  // Required sample: "考虑贲门失弛缓症" hits RED.
  // -------------------------------------------------------------------
  it('matches "考虑贲门失弛缓症" and classifies as RED', () => {
    const input = buildInput({
      diagnoseText: '内镜下考虑贲门失弛缓症，建议进一步检查。',
      rules: [
        buildRule({
          ruleId: 'rule-red-1',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
        }),
      ],
    });

    const result = matchReport(input);

    expect(result.level).toBe('RED');
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0]).toMatchObject({
      ruleId: 'rule-red-1',
      keyword: '贲门失弛缓症',
      level: 'RED',
      field: 'IMPRESSION',
      occurrenceCount: 1,
    });
    const occurrence = result.matchedRules[0].occurrences[0];
    expect(input.diagnoseText!.slice(occurrence.start, occurrence.end)).toBe('贲门失弛缓症');
  });

  // -------------------------------------------------------------------
  // Required sample: "ca" / "CA" / "Ca" under a case-insensitive rule.
  // -------------------------------------------------------------------
  it('matches "ca", "CA", and "Ca" under a case-insensitive CONTAINS rule', () => {
    const rule = buildRule({
      ruleId: 'rule-ca',
      keyword: 'ca',
      level: 'RED',
      matchField: 'IMPRESSION',
      caseSensitive: false,
    });

    for (const variant of ['ca', 'CA', 'Ca']) {
      const input = buildInput({
        diagnoseText: `诊断意见：胃${variant}可能`,
        rules: [rule],
      });
      const result = matchReport(input);
      expect(result.level).toBe('RED');
      expect(result.matchedRules[0].occurrenceCount).toBe(1);
      const occ = result.matchedRules[0].occurrences[0];
      // Offsets must resolve back to the ORIGINAL casing in the source text.
      expect(input.diagnoseText!.slice(occ.start, occ.end)).toBe(variant);
    }
  });

  it('does NOT match differing case when caseSensitive is true', () => {
    const input = buildInput({
      diagnoseText: '胃CA可能',
      rules: [
        buildRule({
          ruleId: 'rule-ca-sensitive',
          keyword: 'ca',
          level: 'RED',
          matchField: 'IMPRESSION',
          caseSensitive: true,
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('UNCLASSIFIED');
    expect(result.matchedRules).toHaveLength(0);
  });

  // -------------------------------------------------------------------
  // Required sample: simultaneous GREEN + RED hits -> final RED, both kept.
  // -------------------------------------------------------------------
  it('resolves to RED when both GREEN and RED rules match, and keeps both matches', () => {
    const input = buildInput({
      describeText: '食管黏膜光滑，未见明显异常。',
      diagnoseText: '考虑贲门失弛缓症；建议随访息肉。',
      rules: [
        buildRule({
          ruleId: 'rule-red',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
        }),
        buildRule({
          ruleId: 'rule-green',
          keyword: '息肉',
          level: 'GREEN',
          matchField: 'IMPRESSION',
        }),
      ],
    });

    const result = matchReport(input);

    expect(result.level).toBe('RED');
    expect(result.matchedRules).toHaveLength(2);
    const levels = result.matchedRules.map((m) => m.level).sort();
    expect(levels).toEqual(['GREEN', 'RED']);
  });

  // Full priority ordering: RED > YELLOW > GREEN > UNCLASSIFIED.
  it.each([
    [['RED', 'YELLOW', 'GREEN'], 'RED'],
    [['YELLOW', 'GREEN'], 'YELLOW'],
    [['GREEN'], 'GREEN'],
    [[], 'UNCLASSIFIED'],
  ] as const)('picks highest level %p -> %s', (levels, expected) => {
    const keywords = ['关键词甲', '关键词乙', '关键词丙'];
    const text = keywords.slice(0, levels.length).join('，');
    const rules = levels.map((level, i) =>
      buildRule({ ruleId: `rule-${i}`, keyword: keywords[i], level, matchField: 'IMPRESSION' }),
    );
    const input = buildInput({ diagnoseText: text || null, rules });
    const result = matchReport(input);
    expect(result.level).toBe(expected);
  });

  // -------------------------------------------------------------------
  // Required sample: empty text.
  // -------------------------------------------------------------------
  it('returns UNCLASSIFIED with no matches for empty/null text', () => {
    const input = buildInput({
      describeText: '',
      diagnoseText: null,
      rules: [
        buildRule({ ruleId: 'rule-1', keyword: '肿物', level: 'RED', matchField: 'REPORT_TEXT' }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('UNCLASSIFIED');
    expect(result.matchedRules).toEqual([]);
  });

  it('returns UNCLASSIFIED when there are no enabled rules at all', () => {
    const input = buildInput({ describeText: '胃息肉', diagnoseText: '未见异常', rules: [] });
    const result = matchReport(input);
    expect(result.level).toBe('UNCLASSIFIED');
    expect(result.matchedRules).toEqual([]);
  });

  it('skips disabled rules', () => {
    const input = buildInput({
      diagnoseText: '考虑贲门失弛缓症',
      rules: [
        buildRule({
          ruleId: 'rule-1',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
          enabled: false,
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('UNCLASSIFIED');
    expect(result.matchedRules).toEqual([]);
  });

  // -------------------------------------------------------------------
  // Required sample: full-width / half-width punctuation normalization.
  // -------------------------------------------------------------------
  it('matches across full-width and half-width punctuation variants without altering reported offsets', () => {
    // Full-width colon/comma/parentheses around the keyword.
    const text = '诊断：贲门失弛缓症（考虑）。';
    const input = buildInput({
      diagnoseText: text,
      rules: [
        buildRule({
          ruleId: 'rule-1',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('RED');
    const occ = result.matchedRules[0].occurrences[0];
    // Offsets are into the ORIGINAL (full-width-preserved) text.
    expect(text.slice(occ.start, occ.end)).toBe('贲门失弛缓症');
  });

  it('matches a half-width-only keyword when source text uses full-width punctuation, via EXACT boundary mode', () => {
    const input = buildInput({
      diagnoseText: '胃溃疡（Ａ级），建议随访',
      rules: [
        buildRule({
          ruleId: 'rule-1',
          keyword: '胃溃疡',
          level: 'YELLOW',
          matchField: 'IMPRESSION',
          matchMode: 'EXACT',
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('YELLOW');
    expect(result.matchedRules[0].occurrenceCount).toBe(1);
  });

  // -------------------------------------------------------------------
  // Required sample: repeated keyword within one field is merged with a count.
  // -------------------------------------------------------------------
  it('merges repeated keyword occurrences in the same field into one MatchedRule with occurrenceCount', () => {
    const input = buildInput({
      diagnoseText: '息肉可见于胃窦，另见息肉一枚于胃体，考虑多发息肉。',
      rules: [
        buildRule({ ruleId: 'rule-1', keyword: '息肉', level: 'GREEN', matchField: 'IMPRESSION' }),
      ],
    });
    const result = matchReport(input);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].occurrenceCount).toBe(3);
    expect(result.matchedRules[0].occurrences).toHaveLength(3);
    // Each occurrence has an independent, correct offset back into the original text.
    for (const occ of result.matchedRules[0].occurrences) {
      expect(input.diagnoseText!.slice(occ.start, occ.end)).toBe('息肉');
    }
  });

  // -------------------------------------------------------------------
  // Required sample: cross-field matches (ALL / REPORT_TEXT scope).
  // -------------------------------------------------------------------
  it('checks both describeText and diagnoseText for a rule scoped to ALL (REPORT_TEXT)', () => {
    const input = buildInput({
      describeText: '食管可见肿物样隆起。',
      diagnoseText: '考虑贲门失弛缓症。',
      rules: [
        buildRule({ ruleId: 'rule-all', keyword: '肿物', level: 'RED', matchField: 'REPORT_TEXT' }),
      ],
    });
    const result = matchReport(input);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].field).toBe('FINDINGS');
  });

  it('produces two separate MatchedRule entries when the same rule hits both fields', () => {
    const input = buildInput({
      describeText: '可见息肉一枚',
      diagnoseText: '考虑息肉',
      rules: [
        buildRule({
          ruleId: 'rule-cross',
          keyword: '息肉',
          level: 'GREEN',
          matchField: 'REPORT_TEXT',
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.matchedRules).toHaveLength(2);
    const fields = result.matchedRules.map((m) => m.field).sort();
    expect(fields).toEqual(['FINDINGS', 'IMPRESSION']);
  });

  it('only checks the scoped field when matchField is FINDINGS or IMPRESSION (not the other field)', () => {
    const input = buildInput({
      describeText: '可见息肉一枚',
      diagnoseText: '未提及息肉',
      rules: [
        buildRule({
          ruleId: 'rule-findings-only',
          keyword: '息肉',
          level: 'GREEN',
          matchField: 'FINDINGS',
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].field).toBe('FINDINGS');
  });

  // -------------------------------------------------------------------
  // Required sample: "未见肿物" is matched by CONTAINS (no negation logic),
  // by design - a human must triage/mark false positive.
  // -------------------------------------------------------------------
  it('matches "肿物" inside "未见肿物" under CONTAINS mode - negation is NOT detected (by design, left to human review)', () => {
    const input = buildInput({
      describeText: '胃底、胃体黏膜光滑，未见肿物。',
      rules: [
        buildRule({
          ruleId: 'rule-negation',
          keyword: '肿物',
          level: 'RED',
          matchField: 'FINDINGS',
        }),
      ],
    });
    const result = matchReport(input);

    // This assertion documents INTENDED behavior, not a bug: the engine
    // performs no medical negation analysis (see strategies/types.ts and
    // the issue's explicit non-goal), so "未见肿物" still counts as a hit
    // and must be resolved by a human (MonitorAction.MARKED_FALSE_POSITIVE).
    expect(result.level).toBe('RED');
    expect(result.matchedRules).toHaveLength(1);
    expect(result.matchedRules[0].keyword).toBe('肿物');
    const occ = result.matchedRules[0].occurrences[0];
    expect(input.describeText!.slice(occ.start, occ.end)).toBe('肿物');
    expect(occ.contextSnippet).toContain('未见肿物');
  });

  // -------------------------------------------------------------------
  // Purity: same input -> deep-equal output across repeated calls.
  // -------------------------------------------------------------------
  it('is a pure function: repeated calls with equal input produce deep-equal (but not same-reference) output', () => {
    const input: MatchInput = buildInput({
      describeText: '食管可见肿物样隆起，未见明显出血。',
      diagnoseText: '考虑贲门失弛缓症，建议随访息肉。',
      rules: [
        buildRule({
          ruleId: 'rule-red',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
        }),
        buildRule({
          ruleId: 'rule-green',
          keyword: '息肉',
          level: 'GREEN',
          matchField: 'IMPRESSION',
        }),
        buildRule({
          ruleId: 'rule-all',
          keyword: '肿物',
          level: 'YELLOW',
          matchField: 'REPORT_TEXT',
        }),
      ],
    });

    const inputSnapshotJson = JSON.stringify(input);
    const result1 = matchReport(input);
    const result2 = matchReport(input);

    expect(result1).toEqual(result2);
    expect(result1).not.toBe(result2);
    expect(result1.matchedRules).not.toBe(result2.matchedRules);
    // Input must not have been mutated by matchReport.
    expect(JSON.stringify(input)).toBe(inputSnapshotJson);
  });

  it('does not mutate the rules array or any rule object passed in', () => {
    const rules = [
      buildRule({ ruleId: 'rule-1', keyword: '息肉', level: 'GREEN', matchField: 'IMPRESSION' }),
    ];
    const rulesJson = JSON.stringify(rules);
    const input = buildInput({ diagnoseText: '息肉息肉息肉', rules });
    matchReport(input);
    expect(JSON.stringify(rules)).toBe(rulesJson);
  });

  // -------------------------------------------------------------------
  // Disclaimer (constant since issue #26 - no review status is carried).
  // -------------------------------------------------------------------
  it('always attaches the fixed monitoring-only disclaimer', () => {
    const input = buildInput({
      diagnoseText: '考虑贲门失弛缓症',
      rules: [
        buildRule({
          ruleId: 'rule-1',
          keyword: '贲门失弛缓症',
          level: 'RED',
          matchField: 'IMPRESSION',
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.disclaimer).toEqual({
      monitoringOnly: true,
      message: '仅用于监测，不作为正式诊断',
    });
  });

  // -------------------------------------------------------------------
  // Regex mode + malformed regex resilience.
  // -------------------------------------------------------------------
  it('supports REGEX matchMode', () => {
    const input = buildInput({
      diagnoseText: '病灶大小约2.5cm，考虑CA可能',
      rules: [
        buildRule({
          ruleId: 'rule-regex',
          keyword: 'CA|癌',
          level: 'RED',
          matchField: 'IMPRESSION',
          matchMode: 'REGEX',
          caseSensitive: true,
        }),
      ],
    });
    const result = matchReport(input);
    expect(result.level).toBe('RED');
    expect(result.matchedRules[0].occurrenceCount).toBe(1);
  });

  it('treats a malformed REGEX rule as no-match rather than throwing', () => {
    const input = buildInput({
      diagnoseText: '考虑贲门失弛缓症',
      rules: [
        buildRule({
          ruleId: 'rule-bad-regex',
          keyword: '(',
          level: 'RED',
          matchField: 'IMPRESSION',
          matchMode: 'REGEX',
        }),
      ],
    });
    expect(() => matchReport(input)).not.toThrow();
    const result = matchReport(input);
    expect(result.level).toBe('UNCLASSIFIED');
  });
});
