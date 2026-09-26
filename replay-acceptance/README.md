# 回放验收数据集（50 例虚构内镜报告）

为「真实病例回放验收方法验证」准备的一批**完全虚构**的内镜检查报告，用来实际比较
**原关键词监控** 与 **关键词 + AI 语义监控** 两条路径的差异。

本目录是**数据与操作脚本**，不是产品功能：不新增生产 API、不新增数据库表、不改任何
`apps/` 或 `packages/` 下的代码、不接入构建 / 迁移 / seed / CI / 部署 / 启动流程。

---

## EPGS Replay Dataset v1（已冻结）

```text
version:     v1
case_count:  50
frozen:      true
frozen_at:   2026-09-26
```

**「冻结」的含义：后续看到 AI 回放结果以后，不允许为了提高测试成绩回头修改任何一例的
报告正文或 expected answer。**

如果后续发现题目本身确实有错：**不静默修改 v1**，先记录原因，再形成 v1.1 / v2 或独立的
修订记录（见 §9.3）。逐项校验结果与内容 hash 见 §9.1 / §9.2。

---

## 1. 先说清楚四条边界

**① 不是真实患者数据。**
姓名一律 `回放测试01`～`回放测试50`，检查号一律 `TEST-REPLAY-001`～`TEST-REPLAY-050`，
正文由 `cases.mjs` 手写合成，不含任何真实姓名、住院号、报告原文或凭据。

**② `expected.*` 是设计者预期，不是医学金标准。**
fixture 里的 `expected_attention`、`expected_level`、`expected_keyword_behavior`、
`expected_ai_behavior`、`rationale` **全部属于「模拟病例设计者预期」（designer expectation）**，
不是医生标注，不是医学金标准，不是临床诊断结论。
它的用途只有一个：衡量系统是否按设计意图工作。

> **后续真实上线验收仍然必须使用「真实脱敏病例 + 医生独立标注」。**
> 本数据集不能替代那一步，也不能用来计算任何准确率、灵敏度或漏检率。

**③ B 组是人工构造的「关键词边界挑战病例」，其漏检比例不可外推。**
B 组 12 例（013-024）的正文是**刻意**避开 30 条规则关键词写出来的，属于
**keyword-boundary challenge cases** —— 它们的用途是验证 #88 是否具备突破现有关键词规则
边界的能力，而不是抽样自真实报告。

> **因此 B 组的关键词漏检比例不能解释为真实医院中的关键词漏检率。**
> 即使后续回放出现「B 组 12 例 / 关键词发现 0 例 / AI 发现 11 例」这样的结果，
> 也只能说明 AI 对这组**边界测试病例**的能力，**不能声称「真实临床漏检改善 xx%」**。
> 真实的漏检率必须在真实脱敏病例上、由医生标注后才能计算（见 ②）。

**④ `expected.replay.csv` 不得被任何分类代码读取。**
它是回放评估的对照答案，不是运行时输入。目前仓库内对 `replay-acceptance/` 的引用数为 **0**
（`apps/`、`packages/`、`prisma/` 全部无引用；`package.json` / CI / `deploy/` / `start.sh` 也都没有）。
把评估答案喂给被判定的系统，等于自己给自己判卷 —— 后续任何改动都必须保持这条。

---

## 2. 病例构成

`A`–`F` 六组，ID 段与场景一一对应，组内刻意在**长度、措辞、医生书写习惯、明确程度**上做变化，
不是一份模板换词。

| 组 | 例数 | ID 段 | 场景 | 验证目的 |
| --- | --- | --- | --- | --- |
| A | 12 | 001-012 | 关键词明显命中，语义也应关注 | 升级后这些患者一条都不能丢 |
| **B** | **12** | **013-024** | **关键词不命中，整份报告语义应关注** | **AI 能否找到关键词漏掉的人（最重要的一组）** |
| C | 8 | 025-032 | 关键词命中，但上下文是否定 / 排除 | 语义校验能否减少机械命中的假阳性 |
| D | 4 | 033-036 | 关键词命中，但属于既往史 | 区分 HISTORY 与本次发现 |
| **CROSS_PATH** | **1** | **037** | **组合路径：既往史命中应被 #87 过滤，本次真异常应由 #88 独立发现** | **两条 AI 路径同时参与且各自做对** |
| E | 6 | 038-043 | 模糊 / 疑似 / 不确定 | 观察 SUSPECTED / UNCERTAIN 的处理 |
| F | 7 | 044-050 | 普通、低风险、基本正常 | 对照组：观察 AI 是否无故升级；其中 **044 / 048 / 049 是困难阴性**（见 §2.1） |

胃镜与肠镜混合（胃镜 40 例、肠镜 10 例），科室取自真实布局（脾胃病一/二/三科、肛肠一/二科、
综合内科），门诊与住院混合，检查日期分布在 2026-09-08 ～ 2026-09-25。

### B 组是怎么做到「不触发任何关键词」的

种子规则的 30 个关键词里包含 `癌`、`肿瘤`、`肿物`、`占位`、`溃疡`、`病变`、`息肉`、`隆起性病变`、
`高级别上皮内瘤变` 等，并且 `Ca` / `NEN` / `SMT` 是**不区分大小写的子串**（`MonitorRule` 表没有
`caseSensitive` 列，worker 构建规则快照时不传该字段，引擎内部走 `toLowerCase()`）。

所以 B / E / F 三组的正文改用真实报告里描述风险的其他说法，例如：
不规则隆起、表面糜烂、质脆、触之易出血、皱襞中断纠集、微血管结构紊乱、边界欠清、
管壁伸展性差、形态固定、中央凹陷覆白苔、堤状隆起。这些词一个都不在规则表里。

`build-dataset.mjs` 会用**真实的 `packages/matching-engine`** 逐例验证这一点，不是靠人工核对。

### 2.1 困难阴性（F 组 044 / 048 / 049）

F 组原有几例过于干净（「黏膜光滑 / 未见明显异常 / 慢性胃炎」），对 **#88 的误报能力**测试太弱：
一份通篇没有异常描述的报告，AI 不报警不能说明什么。所以把 F 组里 **3 例**改成「困难阴性」，
case ID 不变，总数仍是 50：

| case | 局部危险联想 | 句内良性归因 | 设计预期 |
| --- | --- | --- | --- |
| 044（胃镜） | 粗糙、触碰后少量渗血 | 考虑检查操作刺激所致 | `NO` / `NONE` |
| 048（肠镜） | 充血、粗糙、边界尚清、触碰后少量渗血 | 考虑肠道准备及操作刺激所致 | `NO` / `NONE` |
| 049（胃镜） | 粗糙、散在红斑、色泽略不均、边界清楚 | 考虑炎症性改变 | `NO` / `NONE` |

**这 3 例的目标不是测试关键词系统**，而是专门观察：

> **#88 会不会看到几个「危险表面特征」就过度报警，而没有理解完整报告。**

所以它们的正文按正常内镜报告习惯书写（不为了凑 `NO_HIT` 而写出不自然的中文），
修改后**用真实关键词引擎实测**：3 例全部 `NO_HIT`、引擎等级 `UNCLASSIFIED`（见 §9 校验结果）。

### 2.2 CROSS_PATH：TEST-REPLAY-037

037 的报告正文**刻意不改**，但把它从 D 组独立出来，因为它的价值不是普通 HISTORY，而是
**两条 AI 路径同时参与**：

```text
历史信息中的「溃疡」
       ↓
关键词命中 YELLOW（实测：HIT(溃疡)，关键词路径等级 = YELLOW）
       ↓
#87 应识别这是历史信息并过滤
同一份本次报告又存在真正值得关注的异常
（不规则凹陷、覆白苔、边缘隆起、质脆、触之易出血、周围黏膜纠集）
       ↓
#88 独立读取完整报告，应重新发现本次风险
       ↓
最终预期 RED
```

`expected.ai` 用 `SHOULD_FILTER_AND_FIND` 表达「两条路径都要做对」——
只过滤不发现会漏掉这位患者，只发现不过滤则无法证明 #87 在组合场景下没有失效。
注意 `expected.level = RED` 是**两条路径都做对之后**的最终等级；
只跑关键词时库里的 `current_level` 是 `YELLOW`，这是设计如此，不是缺陷。

---

## 3. 文件清单

| 文件 | 作用 |
| --- | --- |
| `cases.mjs` | **唯一事实来源**：50 例的报告字段 + 设计者预期答案 + 理由 |
| `seed-rules.mjs` | 30 条种子规则副本（校验与建库共用，防止两处漂移） |
| `build-dataset.mjs` | 生成下面三个 CSV，并用真实引擎做离线关键词校验。**不连库** |
| `reports.replay.csv` | 生成物，50 行 × 12 列，列序 = `MOCK_CSV_COLUMNS`，直接喂给 CSV 适配器 |
| `expected.replay.csv` | 生成物，50 行 × 8 列，评估对照答案 |
| `cases.review.csv` | 生成物，50 行 × 19 列，**给人读**的合并导出（正文 + 设计预期 + 引擎实测 + 理由），带 BOM |
| `replay-db.mjs` | 唯一的运维脚本：`--load` / `--verify` / `--drop`，带 fail-closed 守卫 |

不要手改这三个 CSV —— 它们全部由 `build-dataset.mjs` 从 `cases.mjs` 生成。

### `cases.review.csv`：给人看的那一份

前两份是给机器用的（列序就是契约）。人 Review 50 例时要左右对照两个文件，所以额外导出
这一份：**一例一行**，报告正文 + 设计预期 + 引擎实测 + 设计理由并排，直接用 Excel 打开
（带 UTF-8 BOM，否则 Excel 会把中文显示成乱码；另两份**不加** BOM，保持导入路径的输入
字节形态可预测）。

两个刻意的选择：

- **中文表头**。这份文件唯一的用途是给人读，不是被代码读。
- **预期答案的列名带「非医学金标准」前缀**。§1② 声明过 `expected.*` 不是医学金标准；
  这份文件把报告正文与设计者预期并排放，最容易被误当成标注集转发出去，所以把这句话
  写进列名，让它跟着文件走。

它**不参与**导入、校验或评估，改它不会影响任何结果；它是从 `cases.mjs` 派生的只读视图，
要改内容请改 `cases.mjs`。

`expected.replay.csv` 的列：

```text
case_id, scenario_type, scenario_label, expected_attention, expected_level,
expected_keyword_behavior, expected_ai_behavior, rationale
```

取值：

- `expected_attention`：`YES` / `NO`
- `expected_level`：`RED` / `YELLOW` / `GREEN` / `NONE`（`NONE` 即 `UNCLASSIFIED`）
- `expected_keyword_behavior`：`HIT` / `NO_HIT` / `FALSE_POSITIVE_RISK`
- `expected_ai_behavior`：`SHOULD_FIND` / `SHOULD_FILTER` / `SHOULD_NOT_FIND` /
  `SHOULD_FILTER_AND_FIND` / `UNCERTAIN`
  - `SHOULD_NOT_FIND` 是在任务给出的三个示例之外补的：F 组要表达的是「AI 不应新增关注」，
    与 `SHOULD_FILTER`（纠正一个已有的错误命中）是两回事。
  - `SHOULD_FILTER_AND_FIND` 是 Replay Dataset v1 修订时补的，**只用于 CROSS_PATH 组**：
    表达「#87 要过滤、#88 要独立发现」两件事都成立（见 §2.2）。

`expected_level` **不是由某个单词决定的**，是看上下文。数据集里刻意放了成对的对照：

| 同一批词 | 语境 | 结论 |
| --- | --- | --- |
| `肿物`（001、006） | 「见菜花样肿物，表面溃破，质脆」 | 命中即真阳性 → RED |
| `肿物`（025、030） | 「未见肿物」 | 否定 → NONE |
| `溃疡`（005） | 「2.5cm 溃疡，边缘不规则隆起，质脆易出血」 | 真阳性 → RED |
| `溃疡`（028） | 「原溃疡处已愈合，未见活动性改变」 | 好转 → NONE |
| `溃疡`（035） | 「既往有胃溃疡病史」 | 既往史 → NONE |
| `恶性肿瘤`（029） | 「未见恶性肿瘤征象」 | 否定 → NONE |
| `恶性肿瘤`（002） | 「食管中段环周浸润性改变……食管恶性肿瘤」 | 真阳性 → RED |
| `占位`（026、032） | 「未见明显占位」「未见占位性改变」 | 否定 → NONE |
| `齿状线上移`（004） | 「齿状线上移约 2cm，疝囊形成」 | 真阳性 → YELLOW |
| `齿状线清晰`（050） | 阴性描述，**不**命中规则 | NONE |

---

## 4. 怎么用

### 4.1 生成并校验数据（不连库，可随时跑）

```bash
node replay-acceptance/build-dataset.mjs
```

它会用真实引擎逐例比对「设计意图」与「当前 30 条规则下的实际行为」，并调用 worker 编译产物里的
`parseCsvReports` 走一遍真实的契约校验。任何一例不符即退出码 1 且**不生成 CSV**。
校验通过则写出全部三个 CSV（含给人读的 `cases.review.csv`）。

只想校验、不覆盖 CSV：`node replay-acceptance/build-dataset.mjs --check`。

> 若提示 `apps/worker/dist` 早于源文件，先 `pnpm --filter @epgs/worker run build` 再重跑，
> 否则会降级为通用 CSV 解析（会明确告警，不会静默跳过）。

### 4.2 建库并导入

```bash
REPLAY_DATABASE_URL=postgresql://epgs:epgs@localhost:5432/epgs_replay \
  node replay-acceptance/replay-db.mjs --load
```

做四件事：建库 → `prisma migrate deploy` → `prisma db seed`（30 条规则）→
`sync:once`（CSV 适配器 → 同步 → 关键词引擎），最后自动跑一次只读校验。

导入走的是**生产同一条路径**（`CsvPacsRisAdapter` + `SyncService.runOnce()`），
不是直接 INSERT —— 直接写 SQL 的话，同步任务根本不会看到这些记录，
`current_level` 与 `monitor_match` 都不会正确生成。

### 4.3 只读校验

```bash
REPLAY_DATABASE_URL=postgresql://epgs:epgs@localhost:5432/epgs_replay \
  node replay-acceptance/replay-db.mjs --verify
```

校验四件事：① 库内启用规则与 `seed-rules.mjs` 逐条一致（漂移检测）；
② 50 条记录全部落库；③ 每条 `current_level` 等于关键词路径应有的等级；
④ `ai_attention_level` / `ai_resolved_at` 全为空（证明 AI 路径未运行）。

### 4.4 删干净

```bash
REPLAY_DATABASE_URL=postgresql://epgs:epgs@localhost:5432/epgs_replay \
  node replay-acceptance/replay-db.mjs --drop
```

`DROP DATABASE`，本机即不再有任何 `TEST-REPLAY` 数据。**不可恢复。**

---

## 5. 用了哪个库、隔离机制是什么

**库：`epgs_replay`（本机 PostgreSQL，`localhost:5432`）。**
不属于任何其他环境：开发库是 `epgs`（api 跑在 3100 上），一次性验证库是 `epgs_ui`、
`epgs_e2e`，回放库与它们完全独立。

导入后的实测结果：

```text
epgs          monitor_record=6   TEST-REPLAY 记录=0     ← 与导入前逐项一致，未被污染
epgs_e2e      TEST-REPLAY 记录=0
epgs_ui       TEST-REPLAY 记录=0
epgs_replay   TEST-REPLAY 记录=50                       ← 数据只在这里
```

`epgs_replay` 里的全部非空表（已实测）：

```text
monitor_record   50    ← 50 条回放报告
monitor_match    52    ← 关键词命中（A 组 27 + C 组 13 + D 组 10 + CROSS_PATH 037 的 2 条）
monitor_rule     30    ← 种子规则
sync_job_log      1    ← 那次导入的作业日志
assistant_event  19    ← worker 启动时的心跳服务顺带写入，与回放数据无关
assistant_heartbeat 1
_prisma_migrations 12
```

**没有** `attention_semantic`（关注语义）行，**没有**任何账号/用户行，**没有**
`monitor_report_ai*`（AI 判读结果）行 —— 也就是说，这个库里此刻只有「关键词一侧」的状态，
正是本阶段想要的基线。

### 为什么可以保证未来部署生产环境时这些数据不会进生产库

七条，逐条可验证：

1. **不在任何自动路径上。** `replay-db.mjs` 没有出现在 `package.json` 的任何 script、
   CI（`.github/workflows/`）、`deploy/`、`start.sh` / `start.local.sh` / `docker-compose.yml`
   或 prisma seed 配置里。部署与启动时没有任何东西会调用它。
   （已核查：这些文件里对 `replay` / `TEST-REPLAY` 的引用数为 0。）
2. **没有默认目标。** 必须由人显式传 `REPLAY_DATABASE_URL`，不传直接失败 —— 没有兜底默认值。
3. **库名白名单。** 必须匹配 `^epgs_replay(_[a-z0-9]+)?$`，且 `epgs` / `epgs_e2e` / `epgs_ui` /
   `postgres` 在显式禁用名单里。指向生产库名会被直接拒绝。
4. **主机必须是本机。** `localhost` / `127.0.0.1` / `::1` / unix socket 之外一律拒绝，
   连不上或指向远程主机（如 `10.10.10.91`）都会被挡下。
5. **`NODE_ENV=production` 直接拒绝。**
6. **写入前检查已有内容。** 只要目标库里存在任何一条 `source_record_id` 不以
   `TEST-REPLAY-` 开头的记录，就整体拒绝写入 —— 保证脚本永远不会往装着真实数据的库里写东西。
7. **迁移与种子后各有一道断言。** 若 `DATABASE_URL` 被子进程读到的 `.env` 覆盖
   （即写到了别的库），断言会失败并**立即中止**，不会继续往下导数据。

以上任一条无法确认（连不上库、查不出内容）时**一律 fail closed**，宁可不写。

数据进入生产库只剩一条途径：有人把这 50 行拷进生产 CSV、再在生产环境跑一次生产同步。
那是一次明确的人为操作，不是本脚本或任何自动化流程的结果。

---

## 6. ⚠️ 已知缺口：这一轮跑不出 C / D / CROSS_PATH 的「纠正」效果

必须提前说明，否则回放时会得到误导性的结论。

**C 组（8 例否定）与 D 组（4 例既往史）的设计意图是「关键词命中但应被 AI 语义纠正」。
但在仓库当前发布的配置下，这条路径不会触发。CROSS_PATH（037）需要 #87 与 #88 同时工作，
因此同样不会触发。**

原因（已核实到代码）：

- 种子规则**全部 30 条的 `semantic_intent` 都是 NULL**（`apps/api/prisma/seed.ts` 里没有
  任何 `semanticIntent`）；`SEMANTIC_JUDGE_ENABLED` 在 worker 的 `.env` 里也没有开启，
  Joi 默认 `false`。
- #87（VALIDATE_MATCH）对 `semanticIntent IS NULL` 的规则**整条跳过** —— 不调用模型、
  不写审计行、不做任何过滤。
- #88（CLASSIFY_REPORT）的队列要求存在已启用的 `attention_semantic` 行；预设语义需要人工
  通过 `POST /api/attention-semantics/import-defaults` 载入，回放库里没有载入。

所以在本数据集当前状态下：

| 组 | 关键词路径 | 设计意图 | 当前配置下实际会发生 |
| --- | --- | --- | --- |
| B（12） | 零命中 | AI 应发现 RED/YELLOW | 取决于 #88 是否配置（见下） |
| C（8）/ D（4） | 命中假阳性 | AI 应纠正为 NONE | **不会发生** —— #87 未启用且无 intent |
| CROSS_PATH（1） | 命中假阳性 + 本次真异常 | #87 过滤 + #88 独立发现 | **不会发生** —— 两条路径都要开 |
| F 困难阴性（3） | 零命中 | AI 不应新增关注 | 只跑关键词路径时看不出差别，必须开 #88 才有意义 |

**我没有为了让数据「好看」而去给规则补 `semanticIntent`、也没有载入预设语义。**
那属于替医院发明医学配置，也违反「不要为了得到漂亮结果去调整 AI 配置」这条要求。
这个缺口需要所有者决定怎么处理，选项大致是：

1. 先给少数几条规则配置 `semanticIntent` 并开启 #87，再跑 C / D 的回放；
2. 先载入 6 条预设关注语义并开启 #88，只验证 B 组（关键词漏、语义发现）；
3. 两件事都做，分两轮跑，分别归因。

在决定之前，C / D 两组在本数据集里的价值是：**记录基线假阳性**
（**12 例**命中了但临床上不应关注 —— C 组 8 + D 组 4），作为升级前的对照。

**037 要单独看。** 它的关键词命中（`溃疡`，YELLOW）同样是假阳性、同样需要 #87 过滤，
但它**不能**记进「基线假阳性」那一栏当作「不应关注」：同一份报告里本次有真实异常，
#88 判读后它**应当**是 RED。把它算进假阳性统计会把一个必须被找到的患者记成误报。

---

## 7. 下一阶段的开关（本轮不要动）

本阶段只准备数据。若之后要跑 AI 一侧，需要（由所有者确认后进行）：

- #88 报告级语义：载入预设关注语义 `POST /api/attention-semantics/import-defaults`，
  并设 `SEMANTIC_REPORT_ENABLED=true`；
- #87 命中校验：给相关规则配置 `semanticIntent`（**这是医学配置决策，不是技术开关**），
  并设 `SEMANTIC_JUDGE_ENABLED=true`。

`sync:once` 的退出码：`0` 全部成功 / `1` 硬失败 / `2` 部分失败（PARTIAL）。

---

## 8. 数据集局限

- 报告由本目录手写合成，**覆盖不了真实报告的措辞多样性**。它的作用是验证「方法」，
  不是验证「准确率」。
- `expected_level` 只表达「系统应当输出什么等级」，不是病情严重程度 ——
  关键词分级本身就是管理关注等级，不是诊断结论。
- 未审阅/未最终确认的报告语义、跨次检查对比、HIS 病史等能力当前系统不具备，
  因此 D 组与 CROSS_PATH 组的既往信息被刻意写进了本次报告正文里。
- F 组的 3 例困难阴性（044 / 048 / 049）是本轮为提高误报测试强度而**人工加难**的，
  它们比门诊真实报告里常见的「干净阴性」更难；不能据此推断真实场景下的误报率。
- 50 例的样本量不足以支撑任何统计结论，只能做定性对照。

---

## 9. Replay Dataset v1：校验结果与冻结记录

### 9.1 v1 校验结果（2026-09-26）

全部数据由 `node replay-acceptance/build-dataset.mjs` 用**真实的 `packages/matching-engine`**
逐例重算，不是人工核对：

```text
总病例数                              50
scenario_type 数量                    A 12 / B 12 / C 8 / D 4 / CROSS_PATH 1 / E 6 / F 7
实际关键词 HIT                        25
实际关键词 NO_HIT                     25
keyword-boundary challenge（B 组）    12
CROSS_PATH                            1
difficult negative                    3   （044 / 048 / 049）
```

**A. 关键词漏掉、设计预期 AI 应发现的病例 —— 共 17 例**（要求为「至少 10 例」，满足）：

```text
B 组 12 例：013 014 015 016 017 018 019 020 021 022 023 024
E 组  5 例：038 039 040 041 042
（全部满足 实际 NO_HIT 且 expected_ai_behavior = SHOULD_FIND）
```

**B. 关键词命中、设计预期应被 #87 过滤/纠正的病例 —— 共 13 例**：

```text
C 组 8 例：025(肿物) 026(占位+溃疡) 027(肿物+息肉) 028(溃疡) 029(肿瘤+恶性肿瘤)
           030(肿物+溃疡) 031(溃疡) 032(占位)
D 组 4 例：033(癌) 034(肿瘤) 035(溃疡) 036(肿瘤+恶性肿瘤)
CROSS_PATH 1 例：037(溃疡)
```

其中 C 组 8 + D 组 4 = **12 例**属于「本次临床上不应关注」的基线假阳性；
037 的命中同样需要被过滤，但它本次确实有真异常，**不计入假阳性**（见 §6 末段）。

**C. Difficult Negative —— 本轮修改的 3 例，重新执行关键词引擎后的实际结果**：

| case | 实际关键词行为 | 引擎等级 | 设计预期 |
| --- | --- | --- | --- |
| TEST-REPLAY-044 | `NO_HIT` | `UNCLASSIFIED` | `NO` / `NONE` |
| TEST-REPLAY-048 | `NO_HIT` | `UNCLASSIFIED` | `NO` / `NONE` |
| TEST-REPLAY-049 | `NO_HIT` | `UNCLASSIFIED` | `NO` / `NONE` |

**D. CROSS_PATH**：

```text
TEST-REPLAY-037
  keyword 实际        HIT(溃疡)          → 关键词路径等级 YELLOW
  预期路径            keyword → #87 filter
                      full report → #88 find
                      final → RED
  expected_ai_behavior  SHOULD_FILTER_AND_FIND
```

隔离库 `epgs_replay` 重新载入后的实测状态（`replay-db.mjs --load` 后自动 `--verify` 四项全过）：

```text
monitor_record 50 / monitor_match 52 / monitor_rule 30
库内等级分布 {"RED":15,"YELLOW":10,"UNCLASSIFIED":25}
零关键词命中 25 条（= B 12 + E 6 + F 7）
ai_attention_level / ai_resolved_at 全为空 —— AI 路径未运行
```

### 9.2 冻结内容 hash（sha256）

```text
cases.mjs             460143c7a451dbbeb3b258dc8df76d32512a52dd16c0f1aac08211a30976823a
seed-rules.mjs        ca7a6925cd243dc22f0ea669b824b6d790b150c76a80729c822b011480973d28
reports.replay.csv    3e73cf60c8e87274d9adab4b2d7beaa759034bcec629dc3460be562e18515d7e
expected.replay.csv   c93f887e681f05eeeb847caecf4806bddeb6945befccb14c9c49b2ae31626f3a
cases.review.csv      904714493d9b2436270327a5baaa0aa466a079878267178b416a97e9e2838448
```

`cases.mjs` 是唯一事实来源；后三个 CSV 由 `build-dataset.mjs` 从它生成。校验 hash 用：

```bash
shasum -a 256 replay-acceptance/cases.mjs
```

### 9.3 v1 修订记录（v1 冻结时并入，此前的草案不算版本）

相对本轮修订前的数据集，只改了 4 例，且没有任何一例被删除或新增：

| case | 改动 | 原因 |
| --- | --- | --- |
| 037 | scenario `D` → `CROSS_PATH`；`expected.ai` → `SHOULD_FILTER_AND_FIND`；补充 rationale。**报告正文未改** | 它的价值是两条 AI 路径同时参与，不是普通既往史 |
| 044 | 正文加入「粗糙／触碰后少量渗血」并给出良性归因 | F 组过于干净，对 #88 误报能力测试太弱 |
| 048 | 同上（肠镜版本，另加「边界」） | 确认困难阴性不是胃镜特有现象 |
| 049 | 正文加入「粗糙／散在红斑／色泽略不均／边界清楚」并给出良性归因 | 同上 |

除这 4 例外，其余 46 例的正文与 expected answer **逐字未动**。

### 9.4 下一阶段（等 Owner 确认 v1 冻结后进行，本阶段不做）

```text
关键词 baseline → #87 / #88 AI replay → 三方结果对照
```

真实验收仍须使用**真实脱敏病例 + 医生独立标注**（见 §1②）。
