/**
 * Seed script for issue #4's acceptance criteria: "初始 6 条红色关键词可由
 * 种子数据或导入文件建立".
 *
 * Creates the 6 initial RED-level keyword rules named in the issue:
 * 癌、肿瘤、肿物、Ca、食管裂孔疝、贲门失弛缓症. All are CONTAINS matches
 * against REPORT_TEXT (the broadest field) except "Ca", which is
 * evaluated case-insensitively per the issue's explicit note ("'Ca'
 * 默认不区分大小写") - the MonitorRule schema has no case-sensitivity
 * flag, so this is expressed by storing the keyword in a fixed case and
 * relying on RulesService's case-insensitive keyword matching for
 * conflict detection; the actual runtime matching behavior (case folding
 * during keyword search) is issue #5's concern (the matching engine), not
 * this API/seed script.
 *
 * YELLOW/GREEN keyword lists are intentionally NOT seeded here - per the
 * issue text, those first-batch word lists still need sign-off from the
 * endoscopy center ("内镜中心确认") and are out of scope for issue #4.
 * See docs/rules-api.md's "待确认事项" section.
 *
 * Idempotent: uses upsert-like create-if-not-exists logic keyed on
 * (keyword, level, matchField, matchMode) so re-running this script
 * (e.g. after `prisma migrate reset`) does not create duplicate rows or
 * throw on a second run.
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

const INITIAL_RED_KEYWORDS: SeedRule[] = [
  { keyword: '癌', level: MonitorLevel.RED, matchField: MatchField.REPORT_TEXT, matchMode: MatchMode.CONTAINS, notes: '初始红色关键词种子（issue #4）' },
  { keyword: '肿瘤', level: MonitorLevel.RED, matchField: MatchField.REPORT_TEXT, matchMode: MatchMode.CONTAINS, notes: '初始红色关键词种子（issue #4）' },
  { keyword: '肿物', level: MonitorLevel.RED, matchField: MatchField.REPORT_TEXT, matchMode: MatchMode.CONTAINS, notes: '初始红色关键词种子（issue #4）' },
  {
    keyword: 'Ca',
    level: MonitorLevel.RED,
    matchField: MatchField.REPORT_TEXT,
    matchMode: MatchMode.CONTAINS,
    notes: '初始红色关键词种子（issue #4）；默认不区分大小写，匹配逻辑由 issue #5 实现',
  },
  { keyword: '食管裂孔疝', level: MonitorLevel.RED, matchField: MatchField.REPORT_TEXT, matchMode: MatchMode.CONTAINS, notes: '初始红色关键词种子（issue #4）' },
  { keyword: '贲门失弛缓症', level: MonitorLevel.RED, matchField: MatchField.REPORT_TEXT, matchMode: MatchMode.CONTAINS, notes: '初始红色关键词种子（issue #4）' },
];

async function main(): Promise<void> {
  console.log('Seeding initial RED keyword rules...');

  for (const rule of INITIAL_RED_KEYWORDS) {
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
      console.log(`  SKIP  "${rule.keyword}" already exists as rule ${existing.id} (idempotent re-run)`);
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
    await prisma.monitorRule.update({ where: { id: created.id }, data: { ruleGroupId: created.id } });

    console.log(`  CREATE  "${rule.keyword}" -> rule ${created.id}`);
  }

  console.log('Done. YELLOW/GREEN keyword lists are intentionally not seeded - pending 内镜中心 sign-off (see issue #4 / docs/rules-api.md).');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
