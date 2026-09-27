# Round 1 — 实际运行条件（已发生的事实记录）

本文件记录 **Round 1 实际是怎么跑的**。条件沿用自 `RUN-BLOCKED.md` 的冻结清单，
**执行过程中未做任何中途变更**（所有者要求：从第一例开始后实验条件不得改变）。

产物：`RESULTS.md`（结论）、`per-case-hospital.csv`（堡垒机原始导出）、
`per-case.json`（对齐期望与 Round 0）、`raw-stats.json`。

---

## 数据集（冻结，逐字节核验）

```text
dataset version   EPGS Replay Dataset v1（frozen 2026-09-26）
reports.replay.csv  sha256 3e73cf60c8e87274d9adab4b2d7beaa759034bcec629dc3460be562e18515d7e
cases.mjs           sha256 460143c7a451dbbeb3b258dc8df76d32512a52dd16c0f1aac08211a30976823a
git commit          a086c6c9e5cb46168e15e833cc2ebcb362e435cb（main）
repo                https://github.com/xrunda/EPGS.git
例数                50（全部 TEST-REPLAY-，合成病例，无真实患者数据）
```

## 运行环境

```text
主机        10.10.11.91（院内侧堡垒机，Ubuntu 26.04 LTS，root）
Node        v24.21.0 / npm 11.19.0 / pnpm 10.33.2（nodejs.org 官方 tarball + SHA256 校验）
PostgreSQL  18.6（apt 安装，本机 5432）
数据库      epgs_replay（隔离回放库；本机不存在 epgs 生产库）
NODE_ENV    development          ← 必须；production 会让 Joi 强制 PACS_ADAPTER_MODE=http/soap
PACS_ADAPTER_MODE  csv           ← 未接触 PACS/RIS/HIS
PACS_MOCK_CSV_PATH reports.replay.csv
SYNC_FIRST_RUN_LOOKBACK_MINUTES  43200
```

**未运行 `start.sh`** —— 它会强制 `NODE_ENV=production` 并启动常驻 worker，
把真实患者数据同步进 `epgs` 库（该库在堡垒机上不存在）。堡垒机上**没有任何 `.env` 文件**。

## 模型

```text
网关      http://10.10.11.200:8080/v1   （医院院内网关，OpenAI 兼容）
模型      dsv4-flash
API key   由所有者运行时以环境变量注入（SEMANTIC_MODEL_API_KEY），未写入任何文件
调用参数  interval=60s batch=5 maxAttempts=3 lease=600s timeout=20000ms
```

## 开关

```text
SEMANTIC_REPORT_ENABLED  true    ← 本轮唯一开启的开关
SEMANTIC_JUDGE_ENABLED   false   ← 保持关闭；#87 不在本轮范围
```

## 语义配置

6 条预设语义，经 `POST /api/attention-semantics/import-defaults` 正式加载
（`createdCount: 6`，全部 `is_enabled = t`，审计行 `ATTENTION_SEMANTIC_CREATE / actor=dev`）。
**未用 SQL 直插。** 加载后未再改动。

## 执行前基线（`--drop` + `--load` 后实测）

```text
monitor_record 50 / TEST-REPLAY 50 / monitor_match 52 / monitor_rule 30（启用 30）
attention_semantic 6 / monitor_report_ai 0 / ai_attention_level 非空 0 / ai_resolved_at 非空 0
等级 RED 15 / YELLOW 10 / UNCLASSIFIED 25
sync: read=50 success=50 failure=0
```

> Round 0 预演把这 50 例全标成已判读，**所以本轮开跑前必须先 `--drop` + `--load`**；
> 单独 `--load` 修不回来。已执行。

## 执行

```bash
pnpm --filter @epgs/worker run classify:once
```

`classify:once` 会启动完整 `AppModule`，因此也会拉起 sync 与通知调度器
（已知副作用，Round 0 已记录）。本轮整轮耗时约 98 秒，短于 5 分钟同步周期，
**本次没有产生 sync 副作用**；通知面 0 条规则，**未发出任何对外通知**。

## 隔离与合规

- 所有数据库操作仅针对 `epgs_replay`；`replay-db.mjs` 守卫：宿主必须是本机、
  库名必须匹配 `^epgs_replay(_[a-z0-9]+)?$`、目标库不得含非 `TEST-REPLAY-` 记录、
  `NODE_ENV=production` 直接中止。
- `epgs` / `epgs_e2e` / `epgs_ui` 未被执行过任何操作（其中 `epgs` 在堡垒机上不存在）。
- 未接触真实 HIS/PACS/RIS，未写入生产库，未发送任何通知。
- 本文件及同目录产物**不含任何密钥、Token、连接串或患者数据**。
