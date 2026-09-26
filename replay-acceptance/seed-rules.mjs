/**
 * 30 条种子规则的副本 —— 抄自 apps/api/prisma/seed.ts 的 SEED_RULES（17 RED + 13 YELLOW）。
 *
 * 为什么写死一份而不是读数据库：
 *   - build-dataset.mjs 必须在数据库存在之前就能跑（先验证数据设计，再建库）。
 *   - 两个脚本共用这一份，就不会出现「校验用一套、建库用另一套」的漂移。
 *
 * 漂移由 replay-db.mjs --verify 兜底：它会断言回放库里的启用规则集合与这里逐条相等
 * （关键词 + 等级 + matchField + matchMode），任何一边变了都会立刻报错。
 *
 * 字段与 apps/worker/src/sync/sync-runner.ts 的 loadEnabledRules() 完全一致：
 * 刻意不传 caseSensitive —— MonitorRule 表没有该列，undefined 在引擎里走
 * toComparisonCase(text, undefined) → text.toLowerCase()，即**不区分大小写**。
 * 这正是 'Ca' 会命中 "cagA"、'NEN'/'SMT' 也会命中小写形态的原因。
 */
export const SEED_RULES = [
  // RED ×17
  ...[
    '癌', '肿瘤', 'Ca', '食管裂孔疝', '贲门失弛缓症', '恶性肿瘤', '浸润性生长',
    '环周浸润', '管壁僵硬', '管腔狭窄', '内镜无法通过', '菜花样肿物', '穿孔',
    '间质瘤', '占位', '胃食管反流病四级', '食管炎3级',
  ].map((keyword) => ({ keyword, level: 'RED' })),
  // YELLOW ×13
  ...[
    '肿物', '高级别上皮内瘤变', '神经内分泌瘤', 'NEN', '隆起性病变', '溃疡',
    '吻合口狭窄', '底端有融合', '齿状线上移', '糜烂带', 'SMT', '病变', '息肉',
  ].map((keyword) => ({ keyword, level: 'YELLOW' })),
].map((r, i) => ({
  ruleId: `seed-rule-${String(i + 1).padStart(2, '0')}`,
  ruleVersion: 1,
  keyword: r.keyword,
  level: r.level,
  matchField: 'REPORT_TEXT',
  matchMode: 'CONTAINS',
  enabled: true,
}));

/** 供校验脚本比对用的规范化键：关键词 + 等级 + 字段 + 模式。 */
export function ruleKey(r) {
  return `${r.keyword}\u0000${r.level}\u0000${r.matchField}\u0000${r.matchMode}`;
}
