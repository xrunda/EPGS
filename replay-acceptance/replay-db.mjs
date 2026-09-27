#!/usr/bin/env node
/**
 * 回放验收数据集的**唯一**运维脚本 —— 建库 / 导入 / 校验 / 删库。
 *
 *   REPLAY_DATABASE_URL=postgresql://epgs:epgs@localhost:5432/epgs_replay \
 *     node replay-acceptance/replay-db.mjs --load
 *
 *   … --verify     只读校验（规则集合、50 条记录、等级是否与关键词路径一致）
 *   … --drop       删库（DROP DATABASE，不可恢复）
 *
 * 刻意**不接** pnpm script、不接 CI、不接 deploy/startup、不接 prisma seed。
 * 只能由人带上显式 URL 手工执行；没有 URL 就没有默认值，直接失败。
 *
 * ---------------------------------------------------------------------------
 * 为什么可以保证生产环境不会出现 TEST-REPLAY 数据
 * ---------------------------------------------------------------------------
 * 1. 本脚本不在 package.json / Dockerfile / deploy/ / CI / prisma seed 里的任何
 *    自动路径上，没有任何东西会在部署或启动时调用它。
 * 2. 目标库必须由调用者显式给出（REPLAY_DATABASE_URL），脚本**没有默认值**。
 * 3. 目标库名必须匹配 ^epgs_replay(_[a-z0-9]+)?$，且不在禁用名单里 ——
 *    `epgs` / `epgs_e2e` / `epgs_ui` / `postgres` 等一律拒绝，改名即失败。
 * 4. 主机必须是本机（localhost / 127.0.0.1 / ::1 / unix socket），远程一律拒绝。
 * 5. NODE_ENV=production 直接拒绝。
 * 6. 写入前还会检查目标库里已有的 monitor_record：只要存在任何一条
 *    source_record_id 不以 TEST-REPLAY- 开头的记录，就整体拒绝写入。
 *    —— 这一条保证脚本永远不会往一个装着真实数据的库里写东西。
 * 7. 上述任一条无法确认（连不上库、查不出内容）时一律 fail closed，不写入。
 *
 * 数据进入生产库的唯一途径是有人把这 50 行拷进生产 CSV 再跑生产同步，那是
 * 一次明确的人为操作，不是本脚本或任何自动化流程的结果。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { CASES } from './cases.mjs';
import { SEED_RULES, ruleKey } from './seed-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const REPORTS_CSV = join(HERE, 'reports.replay.csv');
const PREFIX = 'TEST-REPLAY-';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);
const FORBIDDEN_DB = new Set([
  'epgs', 'epgs_e2e', 'epgs_ui', 'postgres', 'template0', 'template1', 'mlforkidsdb',
]);
const REPLAY_DB_RE = /^epgs_replay(_[a-z0-9]+)?$/;

const mode = ['--load', '--verify', '--drop'].find((f) => process.argv.includes(f)) ?? '--load';

// ---------------------------------------------------------------------------
// 守卫
// ---------------------------------------------------------------------------
function abort(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

function guardedTarget() {
  if (process.env.NODE_ENV === 'production') {
    abort('NODE_ENV=production —— 本脚本拒绝在 production 下运行。');
  }

  const raw = process.env.REPLAY_DATABASE_URL;
  if (!raw || !raw.trim()) {
    abort(
      '必须显式提供 REPLAY_DATABASE_URL（本脚本没有默认值，fail closed）。\n' +
        '  例：REPLAY_DATABASE_URL=postgresql://epgs:epgs@localhost:5432/epgs_replay',
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    abort(`REPLAY_DATABASE_URL 不是合法 URL：${raw}`);
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    abort(`只接受 postgresql:// 连接串，收到：${url.protocol}`);
  }

  const host = url.hostname;
  if (!LOCAL_HOSTS.has(host)) {
    abort(
      `目标主机不是本机（host=${host || '空'}）。回放库只允许建在本机，` +
        `远程/生产主机一律拒绝。`,
    );
  }

  const dbname = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbname) abort('连接串里没有数据库名。');
  if (FORBIDDEN_DB.has(dbname)) {
    abort(`数据库名 "${dbname}" 在禁用名单里 —— 回放数据不得写入该库。`);
  }
  if (!REPLAY_DB_RE.test(dbname)) {
    abort(
      `数据库名 "${dbname}" 不匹配 ${REPLAY_DB_RE}。\n` +
        `  回放库必须以 epgs_replay 开头，避免误伤其他库。`,
    );
  }

  const maintUrl = new URL(url.toString());
  maintUrl.pathname = '/postgres';

  return { url: url.toString(), maintUrl: maintUrl.toString(), dbname, host: host || '(unix socket)' };
}

const target = guardedTarget();

// ---------------------------------------------------------------------------
// psql 辅助
// ---------------------------------------------------------------------------
function psql(connUrl, sql, { allowFailure = false } = {}) {
  const r = spawnSync('psql', [connUrl, '-v', 'ON_ERROR_STOP=1', '-tAc', sql], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (allowFailure) return null;
    abort(`psql 失败：${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.trim();
}

function dbExists() {
  return psql(target.maintUrl, `SELECT 1 FROM pg_database WHERE datname = '${target.dbname}'`) === '1';
}

// ---------------------------------------------------------------------------
// 写入前的最后一道闸：目标库里不能有任何非 TEST-REPLAY 的记录
// ---------------------------------------------------------------------------
function assertNoForeignRecords() {
  if (!dbExists()) return;
  const hasTable = psql(
    target.url,
    `SELECT to_regclass('public.monitor_record') IS NOT NULL`,
    { allowFailure: true },
  );
  if (hasTable === null) {
    abort(
      '无法查询目标库的 monitor_record（连接失败或权限不足）。\n' +
        '  按 fail closed 处理：不写入。请先确认库状态。',
    );
  }
  if (hasTable !== 't') return; // 还没迁移，安全

  const row = psql(
    target.url,
    `SELECT json_build_object(
       'total', count(*),
       'foreign', count(*) FILTER (WHERE source_record_id NOT LIKE '${PREFIX}%')
     ) FROM monitor_record`,
  );
  const { total, foreign } = JSON.parse(row);
  if (Number(foreign) > 0) {
    abort(
      `目标库 ${target.dbname} 里已有 ${total} 条记录，其中 ${foreign} 条不是 ${PREFIX}* —— ` +
        `该库装着别的数据，拒绝写入。\n  如需重建：先 --drop 再 --load。`,
    );
  }
  console.log(`  · 目标库已有 ${total} 条记录，全部是 ${PREFIX}* —— 可安全重跑。`);
}

// ---------------------------------------------------------------------------
// 子进程
// ---------------------------------------------------------------------------
function run(cmd, args, { cwd = REPO_ROOT, env = {} } = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: target.url, ...env },
  });
  if (r.status !== 0) abort(`命令失败（exit ${r.status}）：${cmd} ${args.join(' ')}`);
}

function nodeBin() {
  return process.execPath;
}

// ---------------------------------------------------------------------------
// --load
// ---------------------------------------------------------------------------
function load() {
  console.log(`\n=== 目标回放库 ===`);
  console.log(`  库名 : ${target.dbname}`);
  console.log(`  主机 : ${target.host}`);
  console.log(`  模式 : load（建库 → 迁移 → 种子规则 → 导入 50 条报告）`);

  if (!existsSync(REPORTS_CSV)) {
    abort(`找不到 ${REPORTS_CSV}。请先运行：node replay-acceptance/build-dataset.mjs`);
  }

  assertNoForeignRecords();

  if (!dbExists()) {
    console.log(`\n[1/4] 创建数据库 ${target.dbname}`);
    psql(target.maintUrl, `CREATE DATABASE "${target.dbname}"`);
  } else {
    console.log(`\n[1/4] 数据库 ${target.dbname} 已存在，跳过创建`);
  }

  console.log(`\n[2/4] 应用迁移（prisma migrate deploy）`);
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: join(REPO_ROOT, 'apps/api') });

  // 决定性断言：迁移必须真的落在回放库上。
  // apps/api/.env 里也有 DATABASE_URL，若子进程环境变量没能覆盖它，
  // 迁移会打到那个库（而这里一片空白）—— 此时立刻中止，绝不继续往下写。
  const migrated = psql(
    target.url,
    `SELECT to_regclass('public.monitor_rule') IS NOT NULL
        AND to_regclass('public.monitor_record') IS NOT NULL`,
    { allowFailure: true },
  );
  if (migrated !== 't') {
    abort(
      `迁移没有落在 ${target.dbname} 上（该库里查不到 monitor_rule / monitor_record）。\n` +
        `  DATABASE_URL 很可能被子进程读到的 .env 覆盖了 —— 已中止，未写入任何数据。\n` +
        `  请检查 apps/api/.env 与 pnpm 的 env 传递后重试。`,
    );
  }
  console.log(`  ✓ 迁移已落在 ${target.dbname}`);

  console.log(`\n[3/4] 写入 30 条种子关键词规则`);
  run('pnpm', ['run', 'prisma:seed'], { cwd: join(REPO_ROOT, 'apps/api') });

  const ruleCount = psql(
    target.url,
    `SELECT count(*) FROM monitor_rule WHERE is_enabled = true`,
    { allowFailure: true },
  );
  if (ruleCount !== String(SEED_RULES.length)) {
    abort(
      `种子规则写入异常：${target.dbname} 里启用规则 ${ruleCount} 条，期望 ${SEED_RULES.length} 条。\n` +
        `  同上，这通常意味着 seed 打到了别的库 —— 已中止。`,
    );
  }
  console.log(`  ✓ ${ruleCount} 条启用规则已写入 ${target.dbname}`);

  console.log(`\n[4/4] 导入 50 条报告（生产同步路径：CSV 适配器 → 同步 → 关键词引擎）`);
  console.log(`       两个 AI 开关显式置 false —— 本阶段只准备数据，不跑 AI 回放。`);
  run('pnpm', ['--filter', '@epgs/worker', 'run', 'sync:once'], {
    env: {
      PACS_ADAPTER_MODE: 'csv',
      PACS_MOCK_CSV_PATH: REPORTS_CSV,
      SYNC_FIRST_RUN_LOOKBACK_MINUTES: '43200',
      SEMANTIC_JUDGE_ENABLED: 'false',
      SEMANTIC_REPORT_ENABLED: 'false',
    },
  });

  // sync:once 的退出码 2 = PARTIAL（部分报告失败）；视为失败并提示。
  verify({ afterLoad: true });
}

// ---------------------------------------------------------------------------
// --verify
// ---------------------------------------------------------------------------
function verify({ afterLoad = false } = {}) {
  if (!dbExists()) abort(`数据库 ${target.dbname} 不存在，无法校验。请先 --load。`);

  console.log(`\n=== 只读校验：${target.dbname} ===`);
  let failures = 0;
  const fail = (msg) => {
    failures += 1;
    console.error(`  ✗ ${msg}`);
  };

  // 1) 规则集合必须与 seed-rules.mjs 逐条一致（漂移检测）
  const rulesJson = psql(
    target.url,
    `SELECT coalesce(json_agg(json_build_object(
       'keyword', keyword, 'level', level,
       'matchField', match_field, 'matchMode', match_mode) ORDER BY keyword), '[]'::json)
     FROM monitor_rule WHERE is_enabled = true`,
  );
  const dbRules = JSON.parse(rulesJson);
  const dbKeys = new Set(
    dbRules.map((r) => ruleKey({ ...r, enabled: true })),
  );
  const localKeys = new Set(SEED_RULES.map(ruleKey));
  if (dbRules.length !== SEED_RULES.length) {
    fail(`启用规则数 ${dbRules.length}，期望 ${SEED_RULES.length}`);
  }
  for (const k of localKeys) {
    if (!dbKeys.has(k)) fail(`库中缺少规则：${k.split('\u0000')[0]} [${k.split('\u0000')[1]}]`);
  }
  for (const k of dbKeys) {
    if (!localKeys.has(k)) fail(`库中多出规则：${k.split('\u0000')[0]} [${k.split('\u0000')[1]}]`);
  }
  if (!failures) console.log(`  ✓ 启用关键词规则 ${dbRules.length} 条，与 seed-rules.mjs 完全一致`);

  // 2) 50 条记录必须全部落库，且等级等于「关键词路径应有的等级」（AI 尚未运行）
  const recJson = psql(
    target.url,
    `SELECT coalesce(json_agg(json_build_object(
       'id', source_record_id, 'level', current_level,
       'aiLevel', ai_attention_level, 'aiResolvedAt', ai_resolved_at,
       'matches', (SELECT count(*) FROM monitor_match m WHERE m.monitor_record_id = r.id)
     ) ORDER BY source_record_id), '[]'::json)
     FROM monitor_record r WHERE source_record_id LIKE '${PREFIX}%'`,
  );
  const recs = new Map(JSON.parse(recJson).map((r) => [r.id, r]));

  const require = createRequire(import.meta.url);
  const { matchReport } = require(join(REPO_ROOT, 'packages/matching-engine'));

  const missing = [];
  const levelMismatch = [];
  const aiTouched = [];
  for (const c of CASES) {
    const rec = recs.get(c.id);
    if (!rec) {
      missing.push(c.id);
      continue;
    }
    const expectLevel = matchReport({
      reportId: c.id, reportVersion: 1,
      describeText: c.reportContent, diagnoseText: c.diagnosis,
      rules: SEED_RULES,
    }).level;
    if (rec.level !== expectLevel) {
      levelMismatch.push(`${c.id} 库=${rec.level} 期望=${expectLevel}`);
    }
    if (rec.aiLevel !== null || rec.aiResolvedAt !== null) {
      aiTouched.push(`${c.id} aiLevel=${rec.aiLevel} aiResolvedAt=${rec.aiResolvedAt}`);
    }
  }

  if (missing.length) fail(`缺少 ${missing.length} 条记录：${missing.join(', ')}`);
  else console.log(`  ✓ 50 条记录全部落库`);

  if (levelMismatch.length) {
    for (const m of levelMismatch) fail(`等级不符：${m}`);
  } else {
    console.log(`  ✓ 每条 current_level 都等于关键词路径应有的等级`);
  }

  if (aiTouched.length) {
    for (const m of aiTouched) fail(`AI 已被触发（本阶段不应发生）：${m}`);
  } else {
    console.log(`  ✓ ai_attention_level / ai_resolved_at 全为空 —— AI 路径未运行`);
  }

  // 3) 统计
  const byLevel = {};
  for (const r of recs.values()) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
  const noMatch = [...recs.values()].filter((r) => Number(r.matches) === 0).length;
  console.log(`\n  库内等级分布：${JSON.stringify(byLevel)}`);
  console.log(`  零关键词命中的记录：${noMatch} 条（设计上应等于 B+E+F 三组之和 = 25）`);

  if (failures) abort(`校验未通过：${failures} 项失败。`);
  console.log(`\n✓ 校验通过${afterLoad ? '，回放数据集已就绪' : ''}。\n`);
}

// ---------------------------------------------------------------------------
// --drop
// ---------------------------------------------------------------------------
function drop() {
  if (!dbExists()) {
    console.log(`\n数据库 ${target.dbname} 不存在，无需删除。\n`);
    return;
  }
  console.log(`\n=== 删除回放库 ${target.dbname}（不可恢复）===`);
  // 先断开其它连接，否则 DROP DATABASE 会因占用失败。
  psql(
    target.maintUrl,
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE datname = '${target.dbname}' AND pid <> pg_backend_pid()`,
  );
  psql(target.maintUrl, `DROP DATABASE "${target.dbname}"`);
  console.log(`✓ 已删除 ${target.dbname}。本机不再有任何 TEST-REPLAY 数据。\n`);
}

// ---------------------------------------------------------------------------
if (mode === '--load') load();
else if (mode === '--verify') verify();
else drop();
