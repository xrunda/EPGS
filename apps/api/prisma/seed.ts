/**
 * Seed script for issue #4's acceptance criteria: "初始 6 条红色关键词可由
 * 种子数据或导入文件建立".
 *
 * Creates the keyword rules: 6 initial RED keywords from issue #4
 * (癌、肿瘤、肿物、Ca、食管裂孔疝、贲门失弛缓症), extended on 2026-08-24
 * with the 内镜中心 sign-off list and finalized on 2026-08-25 with the
 * official level classification: RED 17 / YELLOW 13 / GREEN 0. All are
 * CONTAINS matches against REPORT_TEXT (the broadest field) except "Ca",
 * which is evaluated case-insensitively per the issue's explicit note
 * ("'Ca' 默认不区分大小写") - the MonitorRule schema has no case-sensitivity
 * flag, so this is expressed by storing the keyword in a fixed case and
 * relying on RulesService's case-insensitive keyword matching for
 * conflict detection; the actual runtime matching behavior (case folding
 * during keyword search) is issue #5's concern (the matching engine), not
 * this API/seed script.
 *
 * Idempotent: uses upsert-like create-if-not-exists logic keyed on
 * (keyword, level, matchField, matchMode) so re-running this script
 * (e.g. after `prisma migrate reset`) does not create duplicate rows or
 * throw on a second run. It only creates missing rules - it never updates
 * or disables existing rows (edits made in the UI take precedence). To
 * RE-LEVEL rows already in a database (e.g. the 2026-08-25 定稿分级), run
 * the equivalent UPDATE against monitor_rule rather than relying on seed.
 *
 * Run with: pnpm --filter api exec prisma db seed
 * (or directly: pnpm --filter api exec ts-node --transpile-only prisma/seed.ts)
 */
import { PrismaClient, MatchField, MatchMode, MonitorLevel } from '@prisma/client';

const prisma = new PrismaClient();

const SEED_ACTOR = 'system-seed';

interface SeedRule {
  keyword: string;
  level: MonitorLevel;
  matchField: MatchField;
  matchMode: MatchMode;
  notes: string;
}

const SEED_RULES: SeedRule[] = [
  // ==== RED（最高关注，17 条）====
  // 初始 6 条中的 5 条（issue #4；肿物已按 2026-08-25 定稿移至黄色）
  {
    keyword: '癌',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）',
  },
  {
    keyword: '肿瘤',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）',
  },
  {
    keyword: 'Ca',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）；默认不区分大小写，匹配逻辑由 issue #5 实现',
  },
  {
    keyword: '食管裂孔疝',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）',
  },
  {
    keyword: '贲门失弛缓症',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）',
  },
  // 内镜中心 sign-off 新增（2026-08-24）保持红色
  {
    keyword: '恶性肿瘤',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '浸润性生长',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '环周浸润',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '管壁僵硬',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '管腔狭窄',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '内镜无法通过',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '菜花样肿物',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '穿孔',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '间质瘤',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  // 2026-08-25 内镜中心定稿：由黄色调整至红色
  {
    keyword: '占位',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至红色',
  },
  {
    keyword: '胃食管反流病四级',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至红色',
  },
  {
    keyword: '食管炎3级',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至红色',
  },
  // ==== YELLOW（中等关注，13 条）====
  {
    keyword: '肿物',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始种子（issue #4）；2026-08-25 定稿调整至黄色',
  },
  {
    keyword: '高级别上皮内瘤变',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至黄色',
  },
  {
    keyword: '神经内分泌瘤',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至黄色',
  },
  {
    keyword: 'NEN',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至黄色',
  },
  {
    keyword: '隆起性病变',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '溃疡',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '吻合口狭窄',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '底端有融合',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '齿状线上移',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '糜烂带',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: 'SMT',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）',
  },
  {
    keyword: '病变',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；语义较泛，误标风险较高',
  },
  {
    keyword: '息肉',
    level: MonitorLevel.YELLOW,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '内镜中心 sign-off 新增（2026-08-24）；2026-08-25 定稿调整至黄色',
  },
];

async function main(): Promise<void> {
  console.log(`Seeding ${SEED_RULES.length} keyword rules (RED/YELLOW/GREEN)...`);

  for (const rule of SEED_RULES) {
    const existing = await prisma.monitorRule.findFirst({
      where: {
        isEnabled: true,
        keyword: { equals: rule.keyword, mode: 'insensitive' },
        level: rule.level,
        matchField: rule.matchField,
        matchMode: rule.matchMode,
      },
    });

    if (existing) {
      console.log(
        `  SKIP  "${rule.keyword}" already exists as rule ${existing.id} (idempotent re-run)`,
      );
      continue;
    }

    const created = await prisma.monitorRule.create({
      data: {
        keyword: rule.keyword,
        level: rule.level,
        matchField: rule.matchField,
        matchMode: rule.matchMode,
        notes: rule.notes,
        isEnabled: true,
        version: 1,
        ruleGroupId: '00000000-0000-0000-0000-000000000000',
        createdBy: SEED_ACTOR,
        updatedBy: SEED_ACTOR,
      },
    });
    await prisma.monitorRule.update({
      where: { id: created.id },
      data: { ruleGroupId: created.id },
    });

    console.log(`  CREATE  "${rule.keyword}" -> rule ${created.id}`);
  }

  const counts = SEED_RULES.reduce(
    (acc, r) => {
      acc[r.level] = (acc[r.level] ?? 0) + 1;
      return acc;
    },
    {} as Partial<Record<MonitorLevel, number>>,
  );
  console.log('Done. Seeded rules per level:', counts);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
