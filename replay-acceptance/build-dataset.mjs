#!/usr/bin/env node
/**
 * 从 cases.mjs 生成两个 CSV，并用**真实的** packages/matching-engine 逐例校验
 * 「设计者预期的关键词行为」与「当前 30 条种子规则下的实际行为」是否一致。
 *
 * 这是纯离线脚本：不连数据库、不写数据库、不调用任何 AI。
 *
 *   node replay-acceptance/build-dataset.mjs            # 生成 + 校验
 *   node replay-acceptance/build-dataset.mjs --check    # 只校验，不覆盖 CSV
 *
 * 退出码：0 = 全部一致；1 = 有病例的关键词行为与设计意图不符（此时不要导入）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { CASES, SCENARIOS } from './cases.mjs';
// 30 条种子规则 —— 与 replay-db.mjs --verify 共用同一份副本，避免两处漂移。
// 见 seed-rules.mjs 顶部注释：为什么写死、以及漂移如何被兜底。
import { SEED_RULES } from './seed-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const checkOnly = process.argv.includes('--check');

// ---------------------------------------------------------------------------
// 真实引擎
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const enginePath = join(REPO_ROOT, 'packages/matching-engine');
let matchReport;
try {
  ({ matchReport } = require(enginePath));
} catch (err) {
  console.error(
    `\n无法加载 packages/matching-engine（${enginePath}）。\n` +
      `请先构建：pnpm --filter @epgs/matching-engine run build\n`,
  );
  console.error(err.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
const CSV_COLUMNS = [
  'sourceRecordId', 'patientRegistrationNo', 'patientName', 'department', 'bedNo',
  'patientTypeCode', 'patientTypeName', 'examItem', 'examDate', 'examTime',
  'reportContent', 'diagnosis',
];

function csvCell(value) {
  const s = value == null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

const EXPECTED_COLUMNS = [
  'case_id', 'scenario_type', 'scenario_label', 'expected_attention', 'expected_level',
  'expected_keyword_behavior', 'expected_ai_behavior', 'rationale',
];

/**
 * 第三份 CSV：给人看的合并导出，一例一行（报告正文 + 设计预期 + 引擎实测 + 理由）。
 *
 * 前两份是给机器用的 —— reports.replay.csv 列序即导入契约，expected.replay.csv 是
 * 评估对照答案。人 Review 50 例时要左右对照两个文件，所以额外导出这份。
 *
 * 两处刻意的选择：
 * - 中文表头。这份文件唯一的用途是给人读，不是被代码读。
 * - 预期答案的列名带「非医学金标准」前缀。README §1② 声明过 expected.* 不是医学
 *   金标准；这份文件把报告正文和设计者预期并排放，最容易被误当成标注集转发出去，
 *   所以把这句话写在列名里，让它跟着文件走。
 */
const REVIEW_COLUMNS = [
  '病例编号', '组别', '组别说明', '登记号', '姓名', '科室', '患者类型', '检查项目',
  '检查日期', '报告正文', '诊断',
  '设计预期（非医学金标准）_是否关注', '设计预期（非医学金标准）_等级',
  '设计预期（非医学金标准）_关键词行为', '设计预期（非医学金标准）_AI行为',
  '引擎实测_关键词行为', '引擎实测_命中关键词', '引擎实测_关键词等级',
  '设计理由',
];

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------
const problems = [];
const rows = [];

for (const c of CASES) {
  // MatchInput 的 describeText/diagnoseText 对应 report_content / diagnosis 两列。
  const result = matchReport({
    reportId: c.id,
    reportVersion: 1,
    describeText: c.reportContent,
    diagnoseText: c.diagnosis,
    rules: SEED_RULES,
  });

  const matched = result.matchedRules;
  const actual = matched.length > 0 ? 'HIT' : 'NO_HIT';
  const want = c.expected.keyword;
  const wantIsHit = want === 'HIT' || want === 'FALSE_POSITIVE_RISK';

  if (wantIsHit !== (actual === 'HIT')) {
    problems.push(
      `${c.id} (${c.scenario}) 关键词行为不符：设计=${want}，实际=${actual}` +
        (matched.length ? `，命中=${matched.map((m) => `${m.keyword}[${m.level}]@${m.field}`).join(', ')}` : ''),
    );
  }

  rows.push({
    case: c,
    actual,
    keywords: matched.map((m) => m.keyword),
    engineLevel: result.level,
  });
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------
const byScenario = {};
for (const c of CASES) byScenario[c.scenario] = (byScenario[c.scenario] ?? 0) + 1;

console.log('\n=== 病例分布 ===');
for (const [k, v] of Object.entries(SCENARIOS)) {
  console.log(`  ${k}  ${String(byScenario[k] ?? 0).padStart(2)} 例  ${v.range}  ${v.label}`);
}
console.log(`  合计 ${CASES.length} 例`);

const hit = rows.filter((r) => r.actual === 'HIT');
const noHit = rows.filter((r) => r.actual === 'NO_HIT');
console.log(`\n=== 当前 30 条种子规则下的实际关键词行为 ===`);
console.log(`  命中 HIT    ${hit.length} 例`);
console.log(`  未命中 NO_HIT ${noHit.length} 例`);
const fp = rows.filter((r) => r.actual === 'HIT' && r.case.expected.keyword === 'FALSE_POSITIVE_RISK');
console.log(`  其中设计为假阳性（命中但应被纠正） ${fp.length} 例`);

console.log('\n=== 逐例实际命中关键词 ===');
for (const r of rows) {
  const tag = r.actual === 'HIT' ? `HIT  ${r.keywords.join('+')}` : 'NO_HIT';
  console.log(`  ${r.case.id} [${r.case.scenario}] expect=${r.case.expected.keyword.padEnd(21)} ${tag}`);
}

if (problems.length) {
  console.error(`\n✗ 有 ${problems.length} 例与设计意图不符：\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n请修改 cases.mjs 的措辞（而不是修改关键词规则）后重跑。未生成 CSV。\n');
  process.exit(1);
}
console.log('\n✓ 全部 50 例的关键词行为与设计意图一致。');

if (checkOnly) {
  console.log('（--check：未覆盖 CSV）\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
const reportsCsv = toCsv(
  CSV_COLUMNS,
  CASES.map((c) => [
    c.id, c.patientRegistrationNo, c.patientName, c.department, c.bedNo,
    c.patientTypeCode, c.patientTypeName, c.examItem, c.examDate, c.examTime,
    c.reportContent, c.diagnosis,
  ]),
);

const expectedCsv = toCsv(
  EXPECTED_COLUMNS,
  CASES.map((c) => [
    c.id, c.scenario, `${c.scenario} ${SCENARIOS[c.scenario].label}`,
    c.expected.attention, c.expected.level, c.expected.keyword, c.expected.ai,
    c.expected.rationale,
  ]),
);

// 一例一行的合并导出。实测列取自上面那轮真实引擎校验的 rows，不重新算一遍。
const reviewCsv = toCsv(
  REVIEW_COLUMNS,
  rows.map(({ case: c, actual, keywords, engineLevel }) => [
    c.id, c.scenario, SCENARIOS[c.scenario].label, c.patientRegistrationNo, c.patientName,
    c.department, c.patientTypeName, c.examItem, c.examDate, c.reportContent, c.diagnosis,
    c.expected.attention, c.expected.level, c.expected.keyword, c.expected.ai,
    actual, keywords.join(' + '), actual === 'HIT' ? engineLevel : '',
    c.expected.rationale,
  ]),
);

writeFileSync(join(HERE, 'reports.replay.csv'), reportsCsv, 'utf8');
writeFileSync(join(HERE, 'expected.replay.csv'), expectedCsv, 'utf8');
// 只有这份带 BOM：它要直接用 Excel 打开，没有 BOM 时 Excel 会把中文显示成乱码。
// 前两份不加 —— reports.replay.csv 是导入路径的输入，保持字节形态可预测。
writeFileSync(join(HERE, 'cases.review.csv'), '﻿' + reviewCsv, 'utf8');

// 自检：生成的 CSV 必须能被**生产导入路径本身**读回。
// 首选 worker 编译产物里的 parseCsvReports —— 它就是 sync:once 读这个文件时调用的函数，
// 包含表头校验（validateColumns）与逐行契约校验（mapWireReportToDto），
// 因此能在碰数据库之前就挡住「列名写错 / 某行不合契约 / sourceRecordId 重复」。
// dist 可能过期，故与源文件比对 mtime，过期则降级为通用解析并明确告警。
const adapterSrc = join(REPO_ROOT, 'apps/worker/src/pacs-adapter/csv-pacs-ris-adapter.ts');
const adapterDist = join(REPO_ROOT, 'apps/worker/dist/pacs-adapter/csv-pacs-ris-adapter.js');
let dtos = null;
try {
  const { statSync } = await import('node:fs');
  const fresh = statSync(adapterDist).mtimeMs >= statSync(adapterSrc).mtimeMs;
  if (fresh) {
    ({ parseCsvReports: dtos } = require(adapterDist));
    dtos = dtos(reportsCsv);
    console.log(`\n解析自检：使用生产解析器 apps/worker/dist/.../csv-pacs-ris-adapter.js`);
  } else {
    console.warn(
      `\n⚠ apps/worker/dist 早于源文件，跳过生产解析器自检（降级为通用 CSV 解析）。\n` +
        `  如需完整校验：pnpm --filter @epgs/worker run build 后重跑本脚本。`,
    );
  }
} catch (err) {
  console.warn(`\n⚠ 无法加载生产解析器（${err.message}），降级为通用 CSV 解析。`);
}

if (dtos) {
  if (dtos.length !== CASES.length) {
    console.error(`\n✗ 解析出 ${dtos.length} 条记录，期望 ${CASES.length} 条`);
    process.exit(1);
  }
  console.log(`  → ${dtos.length} 条记录全部通过 PACS/RIS 契约校验`);
}

// 通用解析：确认表头顺序与 MOCK_CSV_COLUMNS 逐字一致（无论上面走哪条路径都跑）。
const workerRequire = createRequire(join(REPO_ROOT, 'apps/worker', 'package.json'));
const { parse } = workerRequire('csv-parse/sync');
const parsed = parse(reportsCsv, { bom: true, columns: true, skip_empty_lines: true });
const header = Object.keys(parsed[0] ?? {});
if (parsed.length !== CASES.length) {
  console.error(`\n✗ reports.replay.csv 解析出 ${parsed.length} 行，期望 ${CASES.length} 行`);
  process.exit(1);
}
if (header.join(',') !== CSV_COLUMNS.join(',')) {
  console.error(`\n✗ 表头与 MOCK_CSV_COLUMNS 不一致：\n  ${header.join(',')}`);
  process.exit(1);
}

console.log(`\n已生成：`);
console.log(`  reports.replay.csv   ${parsed.length} 行 × ${header.length} 列   （导入契约，喂给 CSV 适配器）`);
console.log(`  expected.replay.csv  ${CASES.length} 行 × ${EXPECTED_COLUMNS.length} 列   （评估对照答案）`);
console.log(`  cases.review.csv     ${CASES.length} 行 × ${REVIEW_COLUMNS.length} 列   （人读：正文 + 预期 + 实测，带 BOM）\n`);
