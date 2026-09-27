# Round 0 链路预演 —— 结果

> **这不是第一轮验收结论。**
> 模型是公网的 `deepseek-v4-flash`（APIMART），**不是医院网关 `dsv4-flash`**。
> 本文件回答「#88 的链路通不通、系统在这 50 例上会产出什么」，
> **不回答**「部署到医院网关后是什么水平」。第一轮真跑仍待医院网络可达。
> 条件见 [CONDITIONS.md](CONDITIONS.md)。

## 1. 一句话结论

**链路完全跑通，50/50 判读成功、0 错误、0 耗尽；`record-level` 契约守住（抬高 19、压低 0）。**
#88 存在的理由 —— 「关键词漏掉、语义应当发现」的 **17 例，17 例全部被发现**；
困难阴性 7 例**一例都没有被误报**；CROSS_PATH 037 达到设计预期的最终 RED。

## 2. 运行摘要

```text
classify:once finished  claimed=50 classified=50 errored=0 withMatches=32 exhausted=0 levelsChanged=19 pending=0

运行窗口   2026-09-26 16:51:24 → 16:56:21（约 5 分钟）
模型       deepseek-v4-flash  @ https://api.apimart.ai/v1   ← 公网，非医院网关
task       classify-report/1（50/50 一致）
reportVersion 不符   0 / 50
单例耗时   min 2377ms / avg 5941ms / max 13730ms
失败       0 error、0 exhausted、0 pending
```

## 3. 等级分布

| | 关键词路径（跑前） | 跑完 |
| --- | --- | --- |
| RED | 15 | **23** |
| YELLOW | 10 | **20** |
| GREEN | 0 | 0 |
| UNCLASSIFIED | 25 | **7** |

```text
AI 抬高等级   19 例
AI 压低等级    0 例      ← 必须为 0（record-level.ts 的唯一入口契约）
等级不变      31 例
```

19 例抬高与日志的 `levelsChanged=19` 一致。**没有一例被压低** ——
`computeEffectiveLevel`「AI 只能抬高」的契约在本轮 50 例上成立。

未分级从 25 降到 7：18 例零命中的记录被 AI 找到了、因而离开了未分级池。

## 4. 逐例结果

完整逐例数据见同目录 [per-case.csv](per-case.csv)（17 列，含每例的关键词等级、
AI 等级、最终等级、命中的语义名）与 [per-case.json](per-case.json)（含每条发现的
理由与证据条数）。原始汇总见 [raw-stats.json](raw-stats.json)。

## 5. 分组表现

| 分组 | 例数 | AI 有发现 | 说明 |
| --- | --- | --- | --- |
| **SHOULD_FIND 且关键词零命中** | **17** | **17** | README §9.1 的 17 例（B 12 + E 5）。**#88 存在的全部理由** |
| SHOULD_FIND 全体（A12+B12+E5） | 29 | 27 | 漏 003、004（见下） |
| SHOULD_FILTER（C8+D4） | 12 | 3 | 033 / 034 / 036（见下） |
| SHOULD_FILTER_AND_FIND（037） | 1 | 1 | 达到期望 |
| SHOULD_NOT_FIND（F 组） | 7 | **0** | 一例未误报 |
| UNCERTAIN（E 组） | 1 | 1 | — |

### 5.1 关键正面结果

- **17/17。** B 组 12 例（关键词边界挑战，靠改写措辞完全绕开关键词）+ E 组 5 例
  （038–042），全部被语义路径独立发现。这是本轮最有价值的一个数字：
  它证明「关键词漏掉的风险」这条路径真的能补上。
- **困难阴性 044 / 048 / 049 零误报。** 三例都是刻意写成「像但有否定/良性限定」的
  报告，AI 一例都没有新增关注。
- **F 组 7/7 零误报。**
- **037（CROSS_PATH）**：关键词 YELLOW（`溃疡` 假阳性）→ AI 判 RED
  → 最终 **RED**，正是 README §9.1 写明的设计预期。037 的「过滤」那一半仍需 #87，
  但「发现」那一半在本轮真实生效了。

### 5.2 需要所有者判断的两处

**（a）003 / 004 两例 A 组病例 AI 没有独立发现。**

两例关键词都已命中 RED，所以**最终等级仍是 RED，不构成漏诊**。但 A 组的设计是
「关键词与语义都应当发现」，这两例语义路径没跟上。值得看一眼报告原文，
判断是模型保守还是语义配置没覆盖到（003 是贲门失弛缓症，语义预设里没有对应条目，
更像后者）。

**（b）033 / 034 / 036 三例 D 组（既往史）AI 新增了关注。**

三例都已有假阳性关键词 RED（#87 的活，本轮休眠），AI 又各自加了一条发现：
033/034 → YELLOW「治疗后并发症或术后异常征象」，036 → GREEN「与既往检查相比出现变化」。
按 #88 的契约这**不算违约**（AI 只负责补发现，不负责过滤），但这三条是 AI 路径
自身的精确度观察：**它没有识别出「这是既往史」**。
跨次/历史信息的甄别不在 #88 范围内，这里只是记录下来，不建议在本轮据此改任何配置。

## 6. 发现与证据的完整性

```text
AI 发现总数           45（分布在 32 例上）
零证据的发现          0        ← 任务本身拒绝无证据命中，未被绕过
证据总数              64
match_count 与实测不符 0
带 error 的尝试行      0

按语义：
  明确或高度疑似恶性病变        RED     13 次 / 13 例
  活动性出血或近期出血征象      RED      1 次 /  1 例
  性质待定、需活检或短期复查    YELLOW  25 次 / 25 例
  治疗后并发症或术后异常征象    YELLOW   3 次 /  3 例
  多发病变或累及范围广泛        YELLOW   2 次 /  2 例
  与既往检查相比出现变化        GREEN    1 次 /  1 例
```

两处观察：

1. **证据只来自 IMPRESSION（32）与 FINDINGS（32），EXAM_ITEM 一条都没有。**
   检查所见一栏在本轮 50 例上从未被引为证据。
2. **「性质待定、需活检或短期复查的病变」命中 25 例 = 所有有发现病例的 78%。**
   它是本轮的主导语义，覆盖面明显比其余五条宽。**这是配置问题不是代码问题**，
   是否收窄留给所有者在看到医院网关的结果后一并判断 —— 本轮不改。

## 7. 本轮的副作用（必须记录）

`classify:once` 启动的是**完整的 `AppModule`**，不只是分类服务。因此它在跑分类的
同时**顺带运行了 sync 调度器与通知调度器**：

- 16:54:24 sync tick 触发了一次，`read=0 success=0 failure=0` ——
  窗口 `[2026-09-25 15:10, 2026-09-26 16:54]` 内 `Doc/moke-soap-sample.utf8.csv`
  没有记录，**没有写入任何 monitor_record**（50 例全程未被触碰）。
- 它在 `epgs_replay` 里留下了一条 `sync_job_log` 行。除此之外无其它写入。
- 通知面全程封死（`notification_rule=0 / notification_channel=0 / push_delivery=0`），
  外部消息在结构上不可能发出。

**这次无害，但它是真实的越界副作用**，第一轮真跑会遇到同样的情况。
建议单开一个 Issue：`classify:once` 应只装配它需要的模块，不应让一个只读的
一次性任务带起同步与通知调度器。

## 8. 隔离与合规核对

```text
写入的库         仅 epgs_replay
epgs              6 条记录 / 3 条 AI 行 —— 均为 09:53–11:05 的既有合成数据，模型名
                  ui-demo-synthetic，无一条 deepseek-v4-flash
epgs_e2e          0 / 0
epgs_ui           9 条记录 / 6 条 AI 行 —— 既有 synthetic-fixture，同上
TEST-REPLAY 记录  仅存在于 epgs_replay（50），其余三库均为 0
密钥              运行时由环境变量注入，未写入本目录任何文件
```

## 9. 本轮**不能**证明什么

- **不能**替代第一轮。端点是公网聚合网关，服务商基础设施、可能的版本与量化都与
  院内 `dsv4-flash` 不同。数字形态可参考，**结论不可引用为验收结论**。
- **不能**说明 #87 的任何事 —— `SEMANTIC_JUDGE_ENABLED` 全程 false，
  C/D/037 的「过滤」效果本轮**本就不会发生**，与 README §6 的已知缺口一致。
- **不能**说明医院部署后的性能 —— 5941ms 均值是公网网关的延迟，与院内网关无关。

## 10. 跑完必须做的恢复

本轮已把这 50 例全部标成已判读（`ai_resolved_at` 非空），而分类队列取的是
`ai_resolved_at IS NULL`。**不恢复，第一轮真跑会一例都不分类。**

恢复方式（只能是 drop + load，单独 load 修不回来）：

```bash
cd replay-acceptance
node replay-db.mjs --drop
node replay-db.mjs --load      # 自带 --verify 四项
```

**本轮结束时我还没有执行这步** —— 因为结果尚未汇报给所有者。
所有者在确认本轮结果后，我立即执行恢复，再等医院网关。

## 11. 界面侧核对（回放库专用 API `:3102`，与库内数字一致）

```text
GET /api/monitor/exams?pageSize=100      total = 50
attentionSource   BOTH 14 | RULE 11 | AI_REPORT 18 | NONE 7
monitorLevel      RED 23 | YELLOW 20 | UNCLASSIFIED 7
```

交叉核对：关键词命中 = BOTH 14 + RULE 11 = **25** ✓；`NONE` 的 7 例恰好就是
F 组 7 例 SHOULD_NOT_FIND ✓；`AI_REPORT` 18 例全部 `matchedKeywords` 为空 ✓。

也就是说结果已经流到读路径上了：在回放工作台里，列表的「关注理由」会多出
「报告提示需要关注」，未分级从 25 降到 7，语义名只在详情抽屉里出现
（#94 之后界面不再出现「AI / 语义 / 模型」这类机制词）。

## 12. 逐例明细（关键例）

| case | 组 | 期望 | 关键词 | AI | 最终 | AI 发现 |
| --- | --- | --- | --- | --- | --- | --- |
| 037 | CROSS_PATH | RED | YELLOW | RED | **RED** | 性质待定 + 明确或高度疑似恶性病变 |
| 044 / 048 / 049 | F 困难阴性 | NONE | UNCLASSIFIED | — | UNCLASSIFIED | 无 |
| 003 | A | RED | RED | — | RED | 无（关键词已覆盖） |
| 004 | A | RED | RED | — | RED | 无（关键词已覆盖） |
| 033 | D 既往史 | NONE | RED | YELLOW | RED | 治疗后并发症或术后异常征象 |
| 034 | D 既往史 | NONE | RED | YELLOW | RED | 治疗后并发症或术后异常征象 |
| 036 | D 既往史 | NONE | RED | GREEN | RED | 与既往检查相比出现变化 |
| 025 | C | NONE | YELLOW | — | YELLOW | 无 |
