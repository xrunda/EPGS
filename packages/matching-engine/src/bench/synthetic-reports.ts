import type { RuleSnapshot } from '../types';

/**
 * Synthetic (non-patient) report text generator for the issue #5
 * performance benchmark. All content is fabricated boilerplate endoscopy
 * phrasing - no real patient data, per AGENTS.md.
 */

const FINDINGS_PHRASES = [
  '食管黏膜光滑，血管纹理清晰。',
  '贲门开闭良好。',
  '胃底黏膜光滑，未见糜烂。',
  '胃体黏膜充血水肿。',
  '胃窦黏膜可见多发息肉样隆起。',
  '幽门圆形，开闭正常。',
  '十二指肠球部黏膜光滑。',
  '未见明显出血灶。',
  '局部黏膜粗糙，考虑炎症改变。',
  '可见肿物样隆起，表面糜烂。',
];

const DIAGNOSE_PHRASES = [
  '慢性浅表性胃炎。',
  '胃息肉，建议随访。',
  '考虑贲门失弛缓症。',
  '反流性食管炎。',
  '十二指肠球部溃疡。',
  '未见明显异常。',
  '考虑CA可能，建议病理活检。',
  '食管静脉曲张。',
  'Ca不除外，建议进一步检查。',
  '未见肿物。',
];

/** Deterministic pseudo-random generator (mulberry32) so benchmark reports are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticReport {
  reportId: string;
  reportVersion: number;
  describeText: string;
  diagnoseText: string;
}

export function generateSyntheticReports(count: number, seed = 42): SyntheticReport[] {
  const rand = mulberry32(seed);
  const reports: SyntheticReport[] = [];
  for (let i = 0; i < count; i++) {
    const findingsCount = 2 + Math.floor(rand() * 3);
    const diagnoseCount = 1 + Math.floor(rand() * 2);
    const describeText = Array.from(
      { length: findingsCount },
      () => FINDINGS_PHRASES[Math.floor(rand() * FINDINGS_PHRASES.length)],
    ).join('');
    const diagnoseText = Array.from(
      { length: diagnoseCount },
      () => DIAGNOSE_PHRASES[Math.floor(rand() * DIAGNOSE_PHRASES.length)],
    ).join('');
    reports.push({
      reportId: `bench-report-${i}`,
      reportVersion: 1,
      describeText,
      diagnoseText,
    });
  }
  return reports;
}

/** A representative rule set (mirrors realistic RED/YELLOW/GREEN keyword coverage) for benchmarking. */
export function generateSyntheticRules(count = 20): RuleSnapshot[] {
  const keywordsByLevel: Array<[string, RuleSnapshot['level']]> = [
    ['贲门失弛缓症', 'RED'],
    ['肿物', 'RED'],
    ['CA', 'RED'],
    ['癌', 'RED'],
    ['出血', 'YELLOW'],
    ['溃疡', 'YELLOW'],
    ['静脉曲张', 'YELLOW'],
    ['糜烂', 'YELLOW'],
    ['息肉', 'GREEN'],
    ['炎症', 'GREEN'],
    ['胃炎', 'GREEN'],
    ['食管炎', 'GREEN'],
  ];
  const rules: RuleSnapshot[] = [];
  for (let i = 0; i < count; i++) {
    const [keyword, level] = keywordsByLevel[i % keywordsByLevel.length];
    rules.push({
      ruleId: `bench-rule-${i}`,
      ruleVersion: 1,
      keyword,
      level,
      matchField: i % 4 === 0 ? 'REPORT_TEXT' : i % 4 === 1 ? 'FINDINGS' : 'IMPRESSION',
      matchMode: 'CONTAINS',
      caseSensitive: keyword === 'CA',
      enabled: true,
    });
  }
  return rules;
}
