# AI 语义监控（Classify Report）设计 — issue #88

本文件描述一期（PR-A）落地的"报告级 AI 语义判读"：医院配置一组**关注语义**，AI
读完整份报告判断它表达了哪些语义，命中的语义把报告的关注等级**往上**调。

前置阅读：[semantic-judge-design.md](./semantic-judge-design.md)（issue #87，命中级
上下文判读）与 [data-dictionary.md](./data-dictionary.md)。两者共用同一个 AI 语义
引擎（`packages/ai-semantic`），本文件只描述 #88 这一层。

## 1. 这套东西解决什么问题，以及不解决什么

**解决**：关键词只能抓"字"。报告写「胃体见巨大不规则隆起，表面糜烂，质脆」时，
只要医院没把"隆起""糜烂"逐个登记成关键词，这条报告就不会被关注，哪怕它读起来就是
一个需要优先看的病例。#88 让医院用**自己的话**写下"要关注哪种情况"，由 AI 读完整份
报告判断有没有表达这层意思。

**不解决，且一期明确不做**：

- 不做诊断，不给疾病名称、不给分期、不给治疗建议。AI 只回答"这份报告有没有在说这
  几种情况"，别的都不回答。
- 不做跨时间分析（"较前增大"这类比较只有报告自己写了才算，系统不去翻历史报告）。
- 不接 HIS/EMR，不查检验、病理、用药。
- **不降低任何等级**。关键词命中的结果不会被 AI 改小 —— 见 §2。
- 不做按科室启用。一期只有一个总开关 `SEMANTIC_REPORT_ENABLED`（见 §9）。
- 医生对 AI 结论的解释与展示界面（PR-B）不在本轮范围（已在 PR #91 之后的 PR-B 补上，见 §11）。

**在这套东西没有配置、或者开关关掉时，系统行为与改动前完全一致**：工作台、红黄绿、
通知推送、#87 的判读，一样都不变。

## 2. 与 #87 的关键区别：失败方向相反，能加不能减

两个功能共用引擎，但目标相反，这是理解本模块最重要的一点：

|              | #87 Validate Match（命中级）                     | #88 Classify Report（报告级）                   |
| ------------ | ------------------------------------------------ | ----------------------------------------------- |
| 判断对象     | 一条**关键词命中**的上下文                       | **整份报告**（可以完全没有关键词命中）          |
| 作用         | 把命中**排除**出关注                             | **新增**关注语义命中                            |
| 失败怎么办   | fail-open：**保留**原命中                        | fail-safe：**完全不产生** AI 结论               |
| 等级的影响   | 可能让等级降低（过滤掉最后一个命中）             | **只能让等级升高**                              |
| 配置单位     | 规则上的一句话 `semantic_intent`                 | 独立的关注语义池 `attention_semantic`           |
| 开关         | `SEMANTIC_JUDGE_ENABLED`                         | `SEMANTIC_REPORT_ENABLED`（互相独立）           |

"fail-safe"不是指更安全，而是指**失败的方向必须是"什么都没发生"**：超时、网关 500、
返回的不是 JSON、字段类型不对、说了医院没配过的语义、引用的原文在报告里找不到、
报的等级和命中的语义对不上 —— 任何一种都让这次判读**整体作废，一条 AI 命中都不落
库**。没有"部分成功"。

推论（也是验收线）：AI 报 `NONE` 不会把关键词等级降下来；AI 失败/超时/证据不可追溯
不会改变关键词结论；两边都命中时取较高的那个；同一条 `monitor_record` 仍然只走一次
通知流程（通知是按（规则, 窗口日）聚合的，本功能不新增任何逐条推送）。

## 3. 一张图：分类发生在什么位置

```text
PACS/RIS ──► sync-runner ──► monitor_record + monitor_match（关键词命中）
                 │                      │
                 │                      └──► #87 判读（VALIDATE_MATCH）──┐
                 │                                                     │
                 └──► ai_resolved_at = NULL（进入分类队列）              │
                              │                                        │
                              ▼                                        │
                   ClassifyReportService 循环（本 issue）               │
                     取启用的关注语义 ──► CLASSIFY_REPORT ──► 模型       │
                              │                                        │
                     逐条校验证据 ──► 计算等级 ──► 写审计 + 更新等级 ◄────┘
                                                      │
                                                      ▼
                                       record-level.ts（唯一重算入口）
                                                      │
                                                      ▼
                                    monitor_record.current_level ──► 工作台 / 通知
```

要点：**分类只往 `monitor_record` 上加列**（`ai_attention_level` / `ai_matched_at` /
`ai_resolved_at` / `ai_claimed_at` / `ai_attempts`），不改 `monitor_match`，不改
#87 的任何列。

## 4. 分层：共用的 AI 语义引擎，与它上面的任务

`packages/ai-semantic` 是 #87/#88 共用的下层，本 issue **没有重新实现任何基础设施**，
只新增了一个任务：

| 层       | 内容                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------- |
| 模型客户端 | `SemanticModelClient`（HTTP、超时、错误分类：`TIMEOUT` / `NETWORK` / `MODEL_ERROR`）             |
| 任务      | `VALIDATE_MATCH`（#87，`validate-match/1`）、`CLASSIFY_REPORT`（#88，`classify-report/1`）        |
| 输出校验  | 结构化输出解析 + 枚举校验 + 证据校验（#88 复用同一套校验器，另加等级一致性校验）                  |
| 审计      | 内容哈希（`sha256Hex` + `canonicalJson`）、偏移、模型与版本、耗时                                  |

`apps/api` 不依赖 `@epgs/ai-semantic`（配置界面不需要模型能力）；
`@epgs/ai-semantic` 只依赖 `@epgs/matching-engine`。

注入缝：worker 侧用 `SEMANTIC_CLASSIFY_DEPS` 记号注入模型客户端，规格测试据此塞入假
客户端 —— 超时、坏 JSON、伪造证据、陌生语义、等级不一致这些样本因此可以确定性地复
现，不需要网关、密钥或网络。

## 5. 模型输出与"模型不决策"

模型被要求返回：

```json
{
  "attention_level": "RED",
  "matches": [
    { "semantic_id": "…", "confidence": "HIGH", "reason": "…", "evidence": ["…"] }
  ]
}
```

代码对它的态度，**逐项**如下（这是本项目一贯的规则：**模型负责解释，代码负责决定**）：

1. **等级来自代码**。最终等级 = 命中的**有效**语义按医院配置的颜色取最大值
   （RED > YELLOW > GREEN）。模型返回的 `attention_level` **只用于一致性校验和审计**，
   不参与任何计算。
2. **名称与版本来自配置**。模型只回 `semantic_id`；`semantic_name`、
   `semantic_version`、`attention_level` 全部由**这次调用所用的配置快照**回填。所以
   模型不可能凭空造出一个语义名字或颜色。
3. **一致性校验不通过就整次作废**。模型自报的等级与它返回的命中语义算出来的等级不
   一致 ⇒ 整次尝试记为 `INCOHERENT_LEVEL`，**不产生任何 AI 结论**。模型说 RED 无法
   抬等级，说 NONE 也无法压等级。
4. **命中全部保留，不是只留最高**。审计里要能看到模型找到的每一条，等级只是其中的
   最大值。
5. **置信度只做记录**。#87 会按置信度过滤，#88 **不按置信度过滤** —— 一条 AI 命中
   要么有可验证的证据，要么不存在。

## 6. 关注等级怎么算：唯一的重算入口

这是本 issue 风险最高的地方：能影响 `monitor_record.current_level` 的路径有**三条**
—— 同步（首次命中）、#87 判读（过滤命中）、#88 分类（新增 AI 命中）。三份实现迟早
会算出不一样的答案，所以最终等级重算**只允许有一个入口**：

`apps/worker/src/monitor/record-level.ts` → `recomputeRecordLevels(tx, recordIds)`

纯规则部分 `computeEffectiveLevel(keywordLevels, aiLevel)`：
`LEVEL_PRIORITY`（RED > YELLOW > GREEN > UNCLASSIFIED）作用于**两个输入的并集**，
取最大值。这一个式子同时给出了三条性质：

- AI 只能把等级往上抬（并集里加进来的不会更低）；
- AI 报 NONE（`aiLevel` 为 null）等于没加东西，等级不变；
- AI 失败时根本不写这一列，等级自然不变。

三个调用方（`sync-runner`、`semantic-judge.store`、`classify.store`）全部改为调用它，
`semantic-judge.store.spec.ts` 里原来的等级计算测试已搬去 `record-level.spec.ts`，
留在原处的只是"确实转调了共享入口"的委托断言。

重算用的 `GROUP BY` 固定带 `semanticFiltered: false`：被 #87 过滤掉的命中留在
`monitor_match` 里作为证据，但不再驱动等级。写入只在等级**真的变了**的行上发生
（`updateMany` 带 `where: { id: { in }, currentLevel: { not: … } }` 的目标值），所以重
算是幂等的，重复执行不会反复写库。

分类路径的重算在**同一个事务**里做：一条记录不可能出现"等级与它的行不一致"的中间态。

### 6.1 手工脚本 `reclassify:once` 也必须走这个公式（issue #96）

上面那句"唯一入口"在 #96 之前有一个例外：运维脚本
`apps/worker/src/sync/reclassify-once.ts`（`pnpm --filter worker run reclassify:once`）
自己写了一版等级，而且写的是 **`matchReport()` 的关键词结论**，既不看
`semantic_filtered`、也不看 `ai_attention_level`。后果有两个，都是静默的：

- AI 单独判出的等级（关键词零命中）被写回 `UNCLASSIFIED`，患者从工作台消失；而分类
  队列取数是 `ai_resolved_at IS NULL`，已判读的记录不再入队，**这个等级不会自愈**。
- 被 #87 过滤掉的命中重新变成有效命中，于是等级说 RED、它旁边那行证据却带着
  `semantic_filtered = true`，等级与自己的证据互相矛盾。

现在这个脚本改为**只刷新关键词一侧**，等级一律由本文件的
`computeEffectiveLevel(keywordLevels, aiLevel)` 得出：`keywordLevels` 取自本轮
**按当前启用规则集**重新匹配的结果，减去 `semantic_filtered = true` 的命中
（按 `uq_monitor_match_dedup` 键比对），`aiLevel` 原样透传。

它**故意不调用** `recomputeRecordLevels`，因为两者在"规则被停用"这一例上结论不同：
`recomputeRecordLevels` 只读 `monitor_match` 已有行，而旧命中行永不删除，所以停用一条
规则后它仍会算出旧等级；脚本的本意恰恰是"按当前规则集重算"。因此：

- **自动路径**（同步 / #87 / #88）用 `recomputeRecordLevels`，输入是表里的行；
- **手工脚本**用 `computeEffectiveLevel`，输入是本轮重匹配的结果。

两条路径共用同一个公式与同一份 `LEVEL_PRIORITY`，区别只在关键词一侧的数据来源，
并且都遵守"AI 只升不降"。脚本仍然分页遍历**全表**（`take: 200`）、按记录开事务，
不是"顺手清库"的工具；重复执行是幂等的（等级没变就不写）。

## 7. 证据校验与失败一律不产生 AI 结论

模型必须为每一条命中引用原文片段。校验方式是**字面子串**：这段文字必须出现在这次真
正发给它的那个字段文本里（先去空格折叠重试一次），校验通过才换算出
`{ hash, start, end }`。偏移量是 `monitor_record` 自己的坐标（`exam_item` /
`report_content` / `diagnosis`），审计时由有权限的人用报告原文重算那一段即可。

任何一条命中不满足，**整次尝试**记为 `ERROR`（`EVIDENCE_UNVERIFIED`），零条 AI 命中
生效。一期刻意选择严格策略：宁可这次不判，也不产生一条说不清依据的 AI 结论。

失败码（写进 `monitor_report_ai.error`，机器码，绝不含报告原文）：

| 错误码               | 触发                                                             |
| -------------------- | ---------------------------------------------------------------- |
| `TIMEOUT`            | 调用超时（`AbortError`）                                          |
| `NETWORK`            | 传输失败（Node fetch 的 `TypeError`）                             |
| `MODEL_ERROR`        | 其他调用异常 / 网关非 2xx                                         |
| `INVALID_JSON`       | 回复不是 JSON                                                     |
| `SCHEMA_INVALID`     | 字段缺失或类型不对                                                |
| `UNKNOWN_ENUM`       | 出现了契约里没有的等级/置信度取值                                 |
| `UNKNOWN_SEMANTIC`   | 返回了配置里没有的 `semantic_id`                                  |
| `EVIDENCE_UNVERIFIED`| 引用的原文在报告里找不到                                          |
| `INCOHERENT_LEVEL`   | 自报等级与命中语义对不上                                          |
| `EMPTY_INPUT`        | 记录没有可判读的文本（**不调用模型**）                            |

记录级的写入规则（`classify.store.ts`）：

- **OK 尝试定义 `ai_attention_level`**（包括"零命中"这种真实结论，写 NULL，从而让
  重跑能清掉一条过期的旧结论）；
- **ERROR 尝试不动它**。这样一次网关抖动不会抹掉一条已经核实过的判定。失败之后记录
  是**当场出队**还是**留在队列等下一次**，取决于失败的性质，见 §7.1。

两种写入都带 `aiResolvedAt: null` 的守卫，晚到的落败者不会覆盖已定案的结论；落败仍
然留下自己的审计行（一次尝试一行就是溯源链）。

队列本身用**终止时间戳**表示，不是状态列：`ai_resolved_at IS NULL` 即待办，
`ai_claimed_at` + 租约防重复，`ai_attempts` 到顶后由 `resolveExhausted` 直接出队（不再
为它产生审计行）。认领是乐观的：`UPDATE … WHERE` 会**重述 SELECT 的谓词**，所以两个
worker 不可能对同一份报告各花一次模型调用。报告内容变化（重新同步）会把
`ai_resolved_at` 置回 NULL，让改了文字的旧结论不会留下来。

### 7.1 失败分两种：值得再问一次的，与再问多少次都一样的（issue #102）

#102 之前，任何 `ERROR` 都在第一次就写 `ai_resolved_at` 出队，于是
`SEMANTIC_REPORT_MAX_ATTEMPTS` 这个配置**从来没有被用到过**——没有任何代码会把失败的
记录放回队列。一次网关抖动就等于一份报告的 AI 结论永久缺失，而医生端看不出差别。

现在按"再问一次有没有可能得到不同答案"分成两类。判据是一个纯函数（每条都有单测）：
`apps/worker/src/semantic-report/retry-policy.ts`。

| 类别 | 错误码 | 处置 |
| --- | --- | --- |
| **可重试**（答案没到，或路上坏了） | `NETWORK`、`TIMEOUT`、`MODEL_ERROR`、`HTTP_429`、`HTTP_5xx` | 释放认领，记录留在队列，下一轮或租约到期后重试 |
| **确定性**（答案到了但不能用） | `INVALID_JSON`、`SCHEMA_INVALID`、`UNKNOWN_ENUM`、`EVIDENCE_UNVERIFIED`、`EMPTY_CONTEXT`、`EMPTY_INPUT`、`REPORT_TOO_LONG`、`UNKNOWN_SEMANTIC`、`INCOHERENT_LEVEL`、`NO_SEMANTICS` | 第一次就出队 |
| 读不懂的状态码 | 其余 `HTTP_*` | 按确定性处理：不理解的失败要去看，不是重发三遍 |

- 可重试的失败**不写 `ai_resolved_at`**，只把 `ai_claimed_at` 释放回 NULL；`ai_attempts`
  照常累加，到上限后由 `resolveExhausted` 出队。
- 两类失败都留一行审计（`outcome = ERROR` + `error` 机器码 + 累加后的 `ai_attempts`），
  区别只在记录还在不在队列里。
- `INCOHERENT_LEVEL` 归到确定性是**实测结论**：院内堡垒机 2026-09-27、隔离库
  `epgs_replay`、当时唯一命中该码的 TEST-REPLAY-014 重复 5 次返回逐字节一致。表里
  其余各条**没有**这样测过，`retry-policy.ts` 的注释把这一点写明了；将来若发现网关
  确实会抖动，要改的也只有那一张表。

### 7.2 医生端怎么知道"这次没判成"：`aiStatus` 三态（issue #102）

详情接口新增只读字段 `aiStatus`，医生端据此判断当前的关注等级背后有没有 AI 结论：

| 值 | 条件 | 医生端 |
| --- | --- | --- |
| `JUDGED` | 当前报告版本有一条 `OK` 尝试 | 正常显示结论（含"看了但没发现"） |
| `FAILED` | 有 `ERROR` 尝试、当前版本没有 `OK` 尝试，**且记录已出队** | 明确告知结论不完整 |
| `NOT_JUDGED` | 其余情况（没问过、正文已换、还在队列里） | 不额外说明 |

- 三个值都**只读 `outcome` 与队列状态**，不读错误码、模型、耗时——"审计字段不上医生端"
  的边界（§8）没有变。
- `FAILED` 要求记录**已经出队**是关键：还在队列里说明结论还会来，此时说"判不成"是在
  撒谎。
- 它与 `aiJudged` 恒等（`aiStatus === 'JUDGED'` ⇔ `aiJudged === true`，后者为兼容保留）。

**运维处置**：`FAILED` 的正确处置是查 `monitor_report_ai.error` 并修提示词/配置/网关，
**不是反复重试**。传输层故障（网关长时间不可用）恢复后，用
`pnpm --filter worker run classify:once --requeue --failed-only` 把"有 ERROR 尝试、
当前报告版本还没有结论、且已出队"的记录重新入队；不带 `--failed-only` 的 `--requeue`
会重跑全部记录，代价大得多。

### 7.3 等级分歧：两边都算数，但颜色不一样（issue #103）

#87 的判读只做减法（让一条命中"不计入关注"），**它已经可见**：命中上带着"未计入关注"
的标注。等级分歧是另一种形态，第 6 节的取最大值规则下它一直存在却从不显形：**同一处
病变，关键词规则说红色、整份报告判读说黄色**。两边都算数，记录取 MAX = 红色，所以
记录本身没错——错的是配置。

**判定规则**（唯一实现：`apps/api/src/monitor/level-conflict.ts` 的 `findLevelConflicts`，
医生端与管理员端共用，不写第二份，尤其不写成 SQL）：

1. **同一列**才比。`monitor_match.matched_field` 存的是**实际命中的那一列**
   （匹配引擎把规则的 `matchField` 展开成具体列逐列匹配），所以只可能是 `FINDINGS`
   （报告内容）或 `IMPRESSION`（诊断）；AI 侧的 `EXAM_ITEM` 结构上不可能配对。
2. **区间相交**才算：`hit.matchStart < ev.end && ev.start < hit.matchEnd`（首尾相接
   `end === start` 不算）。关键词侧偏移为空（#87 之前的历史数据）时退回"AI 证据**重算
   出的原文**包含该关键词"，复用 `reconstructEvidence` 的越界/哈希校验；**重算不出来
   就不配对**（宁可漏报）。
3. **等级不同**才报。相等即一致。

**输出按 `(列, 关键词, 关键词等级, 语义名, 语义等级)` 去重**：一条发现的多条证据压在
同一命中上只算一条分歧；但一命中对多发现、一发现对多命中各自都算。

**两个界面，一份判定：**

- 医生端：详情抽屉在「关注依据」列表**外**渲染一句只读提醒，点名两侧的名字与等级。
  位置刻意在空状态三元判断之外（issue #102 的教训），且**空数组时什么都不渲染**——
  一条天天挂着的提醒等于没有提醒。
- 管理员端：`GET /api/monitor/level-conflicts`（RULE_ADMIN）列出窗口内所有打架的配置
  组合、影响多少条记录、有没有人核对过，可标已读/未读。详见
  [monitor-level-conflict-api.md](./monitor-level-conflict-api.md)。

**不是闭环（issue #26）。** 管理员端标记的键是**配置组合**（规则组 + 语义组 + 列 +
两个等级），意思是"有管理员看过这组配置了"，**不是**"这位患者的报告被阅读或处置过"。
路由用 `/read`、文案用「已读/未读」，全套避开上报/知晓/处理/误报/日报的词，红线门禁
`closed-loop-absence.spec.ts` 照旧通过。列表里没有任何患者信息。

**键为什么用组 ID 而不是版本行**：规则与语义是版本化的（改文字生成新行），用版本行
做键会让每次改词都变成一条新问题，已经核对过的人反复看到它诈尸。**等级变了键就变**，
因为那是真的另一种分歧。

## 8. 审计与隐私

`monitor_report_ai` 一次尝试一行，append-only；命中写 `monitor_report_ai_match`，证据
写 `monitor_report_ai_evidence`。它能回答 issue #88 §13 的那个问题："这份报告当时为什么
被 AI 判成红色？依据的是医院哪一版关注语义？"

**不落库的东西**：报告原文、提示词、模型原始响应、证据原文。存的是内容哈希
（`input_hash` / `report_hash` / `config_hash` / `evidence_hash`）和偏移量。三个哈希各
自对应一件事：这次发给模型的是什么（含配置快照）、读的是哪一版报告文字、依据的是哪
一版关注语义配置。

`reason` 是模型给医生看的解释句，唯一一段自由文本，硬上限 300 字符，按 MEDIUM 处理
（无 `patientDetail` 权限时置空），且**从不写日志**。`classify.service.spec.ts` 里有一
条扫描日志的用例，断言报告正文、诊断原文和模型理由都不会出现在任何一条日志里。

## 9. 配置与开关

worker 环境变量（`.env.example` 有逐项注释）：

| 变量                               | 默认    | 说明                                             |
| ---------------------------------- | ------- | ------------------------------------------------ |
| `SEMANTIC_REPORT_ENABLED`          | `false` | **总开关**，也是本功能唯一的开关                  |
| `SEMANTIC_REPORT_TIMEOUT_MS`       | `20000` | 单次调用上限（读整份报告，比 #87 宽）             |
| `SEMANTIC_REPORT_MAX_TOKENS`       | `1024`  | 回复长度上限                                     |
| `SEMANTIC_REPORT_MAX_CHARS`        | `20000` | 送出的报告长度上限，超出截断并在审计里留痕        |
| `SEMANTIC_REPORT_INTERVAL_SECONDS` | `60`    | 循环周期                                         |
| `SEMANTIC_REPORT_BATCH_SIZE`       | `5`     | 每轮条数（避免饿死同进程的同步任务）              |
| `SEMANTIC_REPORT_MAX_ATTEMPTS`     | `3`     | 失败重试上限                                     |
| `SEMANTIC_REPORT_LEASE_SECONDS`    | `600`   | 认领租约，须大于 `batchSize × timeout`           |

模型连接沿用 #87 的 `SEMANTIC_MODEL_*`（同一家医院只有一个网关）。与 `PACS_*` 不同，
这些变量**不在开关打开时强制要求**：worker 同时跑同步任务，缺模型地址应当让分类能力
失效而不是让整个 worker 起不来。缺配置时模块打印一条说明并降级为"只做关键词监测"。

**预置语义只能显式载入**（所有者决定）：任何迁移、任何 seed 都不会写入医学配置。
医院不点按钮就一条语义都没有，此时分类循环**不认领任何记录**（认领了就等于在没有判
据的情况下把队列标成已完成，以后配好语义也不会再判），并在日志里说明
`no attention semantic is enabled`。"载入预置语义"是唯一入口，幂等，默认不覆盖同名条
目（避免一次按钮点击悄悄改掉医生已经审过的颜色），是否覆盖由操作者显式勾选，结果按
条数回报。

手工跑一轮：`pnpm --filter worker run classify:once`（`--max-batches=`、`--record=`、
`--since=`、`--requeue`）。`--requeue` 只重置 `ai_resolved_at` 等队列列，
**不清 `ai_attention_level`** —— 重跑期间等级不会消失。

## 10. 怎么手工验证（上线前）

**CI 全绿不等于医学效果被接受**，这一节是 `SEMANTIC_REPORT_ENABLED=true` 之前必须做完
的动作。

1. **回滚基线**：开关保持 `false` 启动 worker，工作台、红黄绿、通知推送、#87 判读全部
   与改动前一致，且日志里**没有**任何分类循环的活动。这是回滚基线，先确认它。
2. **验通网关**：填好 `SEMANTIC_MODEL_*` 后 `pnpm --filter worker run semantic:probe`。
3. **配语义**：进「AI 语义监控」，先点「载入预置语义」拿一份通用模板，然后**逐条改成
   本院的说法**。预置文案不是任何学会或医院的标准，也没有经过临床验证，直接用等于用
   别人写的定义判断本院报告。
4. **小批量试跑**：`pnpm --filter worker run classify:once`，观察统计（认领 / 成功 /
   失败 / 命中数 / 等级变化 / 待办）与 `monitor_report_ai` 的 `error` 分布。失败率不
   为 0 时先查失败码，不要急着开量。
5. **脱敏报告回放（必做）**：用**脱敏后的真实报告** + 医生**手工标注**的期望结果跑一
   轮，逐条比对：该命中的有没有命中、不该命中的有没有误伤、等级是否符合预期。这一步
   是医学效果的验收，测试只能证明代码按契约执行，证明不了语义本身对不对。
6. **看等级收敛**：抽查若干条记录，确认 `current_level` 等于
   `max(未被过滤的关键词命中等级, AI 等级)`；再拔掉模型地址跑一轮，确认等级**完全不
   变**、只多出 `outcome=ERROR` 的审计行。**注意这一轮现在会重试**（§7.1）：拔掉地址
   属于传输层失败，记录会留在队列里反复失败，同一份报告出现**若干行** ERROR 直到
   `SEMANTIC_REPORT_MAX_ATTEMPTS` 到顶才出队——这是预期行为，不是重复写入的 bug。
   医生端此时仍是 `NOT_JUDGED` 而不是 `FAILED`，因为结论还在路上；跑够若干轮后再看，
   才应该变成 `FAILED`。
7. **确认通知没变**：AI 命中不产生任何逐条推送，通知内容与条数与改动前一致。
8. **看等级分歧（issue #103）**：抽一条关键词与判读颜色不同的记录，确认医生抽屉里出现
   那句双方点名的提醒；再进「等级分歧」核对同一组配置在待办里、`涉及记录` 计数合理，
   标为已读后刷新仍是已读。**这一页只读配置，不含任何患者信息**。

## 11. 一期不做的事（避免误读）

- PR-B（医生解释与展示）**已完成**：工作台列表在「关注等级」单元格内显示来源徽标
  （关键词 / AI 语义 / 两者），详情抽屉新增「AI 语义发现」区块，逐条展示关注语义名称、
  配置颜色、把握度、模型的解释句，以及**服务端按偏移从报告原文重算出的证据片段**
  （原文不落库，见 `docs/api/monitor-api.md` 的「报告级 AI 语义发现字段」）。
  预警链接 H5 面**不返回**这些字段，通知形态未变。
  **其中医生侧的口径已由 issue #94 调整**：来源徽标从工作台与抽屉移除，两个并列区块
  合并为一个「关注依据」列表，列表的关键词列换成「关注理由」列。**服务端行为、数据
  与 API 契约完全未变**（`attentionSource` / `ruleId` / `ruleVersion` 仍在 wire 上），
  变的只是呈现口径——取舍理由见 `docs/rules-config-ui.md` 的「医生看到什么」。
- 不做按科室启用；只有一个总开关。
- 不做跨时间分析、不接 HIS/EMR、不做自动诊断。
- 不因为 #88 顺手改 #87 的判读逻辑、不改个人微信/企微卡片通知的形状。
