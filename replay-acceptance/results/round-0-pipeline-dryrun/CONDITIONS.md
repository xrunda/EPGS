# Round 0 — 链路预演（`CLASSIFY_REPORT`）实验条件

> **定性：这不是第一轮验收结果。**
> 本轮的模型端点**不是医院 AI 网关**，而是公网聚合网关 APIMART。
> 它回答的是「链路通不通、系统在这批报告上会产出什么」，**不是**「医院部署的水平」。
> 第一轮真跑仍须在医院网关上执行，条件另记。

## 为什么跑这一轮

第一轮的模型网关（`10.10.11.200:8080`，模型 `dsv4-flash`）从本机不可达 ——
aTrust 只给这台机器下发了 `10.1.130.34/32` 一条路由，没有 `10.10.0.0/16`，
详见 `../round-1-88/RUN-BLOCKED.md`。为了不把**唯一一次**「第一次真实结果」
赌在链路本身不崩上，先用公网网关把链路走通一遍。

## 实验条件（跑前冻结）

```text
dataset version      v1（frozen，2026-09-26）
dataset hash         cases.mjs 460143c7a451dbbeb3b258dc8df76d32512a52dd16c0f1aac08211a30976823a
git commit           a086c6c9e5cb46168e15e833cc2ebcb362e435cb（main）
task version         classify-report/1（CLASSIFY_REPORT_PROMPT_VERSION）
prompt hash          classify-prompt.ts   38ddcd6b1685648c9b1cd8f627665bfb906733ceb3ee67054bcc0aa4af1716e5
                     classify-types.ts    90b151289e0cd4a8d9d700724664a4770bcdfee48ff2bf659877ec4628be2a9c
                     classify-report.ts   0b31ab5f447f3c18214ece8cb1c813f25bba5a085a47c66e90c062c2c4061cb3

model                deepseek-v4-flash
model endpoint       https://api.apimart.ai/v1      ← 公网聚合网关，非医院网关
provider             APIMART（OpenAI 兼容 /v1，api_style=openai-chat）
api key              运行时从环境变量注入；不写入本文件、不写入任何入库文件

env flags            SEMANTIC_REPORT_ENABLED = true      ← 本轮唯一开启的路径
                     SEMANTIC_JUDGE_ENABLED = false     ← #87 全程关闭，未混跑
                     SEMANTIC_MODEL_API_STYLE = openai-chat
                     semantic_intent 未添加（#87 所需字段，本轮不碰）

semantic config      6 条预设，全部 enabled，version=1，created_by=dev
                     （经 POST /api/attention-semantics/import-defaults 加载，
                       审计行 ATTENTION_SEMANTIC_CREATE / actor=dev）
                     RED    b7ac4c80-acf1-4586-be0b-2816431e1461  明确或高度疑似恶性病变
                     RED    7e78f67c-0a23-4b1c-a37c-ae080bd2f0f2  活动性出血或近期出血征象
                     YELLOW 226060c7-ba6c-4049-9818-79b8dd50bccd  性质待定、需活检或短期复查的病变
                     YELLOW c8a8cf43-6098-490d-b99b-69cc2cd89419  治疗后并发症或术后异常征象
                     YELLOW bd6fad04-3a6a-482b-a277-ddc91744f212  多发病变或累及范围广泛
                     GREEN  4e2fc7fa-1834-428e-823d-efd1ae0fc9e1  与既往检查相比出现变化

数据库               仅 epgs_replay（隔离回放库）。epgs / epgs_e2e / epgs_ui / 生产库零写入。
通知                  notification_rule=0 / notification_channel=0 / push_delivery=0
                     —— 外部通知在结构上不可能发出
```

## 与第一轮的关键差异（不得混淆）

| 项 | 本轮（Round 0） | 第一轮（待跑） |
| --- | --- | --- |
| 模型 | `deepseek-v4-flash` | `dsv4-flash` |
| 端点 | `https://api.apimart.ai/v1`（公网） | `http://10.10.11.200:8080/v1`（院内） |
| 定性 | 链路预演 | **验收结论** |

`dsv4-flash` 与 `deepseek-v4-flash` **极可能是同一个模型**（dsv4 = DeepSeek V4），
所以本轮的分布形态有较高参考价值；但端点、服务商基础设施与可能的版本/量化差异仍在，
**结论不能相互替代**。

**每一行 AI 审计都自带模型名**（`monitor_report_ai.model` 为 NOT NULL），
所以本轮的产物永远可与第一轮区分，不会混淆。

## 跑完必须做的恢复（重要）

预演会把这 50 例全部标成已判读（`ai_resolved_at` 非空），而分类队列的取数条件是
`ai_resolved_at IS NULL`。**若不恢复，第一轮真跑会跳过全部 50 例**，表现为
「AI 一条都没发现」。

恢复方式只能是 `replay-db.mjs --drop` + `--load` —— 单独跑 `--load` 修不回来。

## 本轮的规矩（与第一轮相同）

看到任何结果，**都不许**回头改 Prompt / 关注语义 / 回放病例再跑第二轮。
v1 已冻结，改题只能走 v1.1/v2 并记录原因。
