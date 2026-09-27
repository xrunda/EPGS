# Round 1 — #88 CLASSIFY_REPORT 回放：阻塞记录（**已解除，本轮已跑完**）

> ## ⚠️ 本文件描述的阻塞已于 2026-09-26 解除，Round 1 **已经跑完**
>
> 堡垒机 `10.10.11.91` 在院内网内，可直达网关 `10.10.11.200:8080`（本机不可达的问题
> 在堡垒机上不存在）。**实际结果见同目录 `RESULTS.md` / `CONDITIONS.md` /
> `per-case-hospital.csv`。**
>
> 本文件以下内容保留为**历史记录**：它固定了本轮沿用且未中途变更的实验条件，
> 以及当初停下来的原因。第 2 节的阻塞点（`RULE_ADMIN` 账号 / 预设语义）同样已解决。
>
> **本轮已于完成后按约定停止：未开始第二轮 #87。**

**（以下为解除前的原始记录）状态：BLOCKED（只剩网络一项）。0 例被分类。**

> **2026-09-26 16:56 补记：** 为不等网络而先验证链路，已用**公网网关**跑了一轮
> **Round 0 链路预演** —— 结果在 `../round-0-pipeline-dryrun/`，
> **模型不是医院网关，不作为验收结论**。
> 注意预演已把这 50 例全部标成已判读，**跑 Round 1 前必须先 `--drop` + `--load` 恢复基线**，
> 否则真跑会一例都不分类。（已在 Round 1 执行前完成。）

前置条件进展：**模型网关配置已提供**（但本机网络不可达，见阻塞点 1）；
**`RULE_ADMIN` 账号与 6 条预设语义已就位**（阻塞点 2 已解决）。

本轮**没有**运行 `CLASSIFY_REPORT`，因此本目录下**不存在**任何逐例结果文件。
这里只记录停下来的原因与已固定的实验条件，供下一轮直接沿用、避免条件漂移。

> 本文件**不含任何密钥**。网关 `api_key` 由所有者在运行时注入，不落任何入库文件。

## 停止原因

### 1. 模型网关：接入资料已提供，但**本机当前无法到达该网段**（阻塞 §4 / §5 / §6）

所有者已提供 OpenAI 兼容网关的接入资料（`README-codeagent-api.md`，**位于仓库之外**）。
所需配置项已从代码确认（`apps/worker/src/semantic/semantic-model.factory.ts:69-75`：
`SEMANTIC_MODEL_BASE_URL` 与 `SEMANTIC_MODEL_NAME` 为必需项，`SEMANTIC_MODEL_API_KEY`
可选；`SEMANTIC_MODEL_API_STYLE` 目前只实现 `openai-chat`）：

| 项 | 值 |
| --- | --- |
| `SEMANTIC_MODEL_BASE_URL` | `http://10.10.11.200:8080/v1` |
| `SEMANTIC_MODEL_NAME` | `dsv4-flash`（OpenAI Chat Completions） |
| `SEMANTIC_MODEL_API_KEY` | 已由所有者提供（**不写入本文件及任何入库文件**） |

**但该地址从本机不可达**，因此仍然无法开跑：

| 检查 | 结果 |
| --- | --- |
| `curl -m 8 .../v1/models`（带 key） | `HTTP=000`，5.0s 超时，**无响应体** |
| 到 `10.10.11.200` 的路由 | `gateway 198.18.0.1, interface utun6` —— 被 Clash TUN 接管 |
| 经 Clash 代理 `127.0.0.1:7897` | **502**（代理配置里没有 `10.10.x` 规则，落到默认节点） |
| 绕过 TUN 走物理网卡 `en0` (192.168.1.92) | 8.0s 连接超时 |
| `traceroute -m 5 10.10.11.200` | 5 跳全部 `* * *` |
| 堡垒机 `10.10.10.91` | ping 100% 丢包（同样不可达） |
| 本机默认网关 `192.168.1.1` | 正常，4.3ms —— **所以不是本机断网** |

结论：这是**网络可达性问题**（需处于院内网络或医院 VPN 内），**不是代码或配置问题**。
**没有**去改本机路由、Clash 规则或安装 VPN 客户端 —— 那属于所有者侧的网络决策，
不在本 Issue 授权范围内。

补充（与上一轮结论一致、仍然成立）：仓库内**故意**没有任何真实网关值
（`apps/worker/src/config/env.validation.ts:151` 注释原文：
`e.g. http://10.0.0.5:8000/v1 - no real value exists in this repo/CI.`），
唯一的 `FakeModelClient` 都在 `.spec.ts` 单测文件里。网关按设计「每个部署单独注入、
绝不入库」，因此只能由所有者在运行时提供。

网关不可达期间**没有**改用任何模拟分类器 —— 用一个假模型跑出来的数字不回答本轮
要回答的问题（系统现在真实处于什么水平），所以宁可停下来。

### 2. ~~加载预设语义需要 `RULE_ADMIN` 账号~~ —— **已解决（2026-09-26 14:37）**

`POST /api/attention-semantics/import-defaults` 是预设语义生效的**唯一**途径
（`defaults.ts` 明确：迁移绝不写医学配置，必须由人显式加载并留审计行），
且该端点标注 `@RequireRoles(AppRole.RULE_ADMIN)`；而 `epgs_replay` 里原本 `app_user = 0`。

**建账号走的是项目自己的 `pnpm --filter api run auth:create-user`，没有用 SQL 直插。**
`readHiddenPassword`（`auth-cli.ts:75-78`）要求 `process.stdin.isTTY`，但可以用 `expect`
开一个真实 PTY 非交互地完成。**两个必须踩准的细节**：

1. 该函数是**先 `process.stdout.write(prompt)`、再 `setRawMode(true)`**（`:81-82`）。
   在匹配到提示语之后立刻输入，字符会以 canonical 模式被缓冲并回显，整行作为一个 chunk
   送达 → 永远匹配不上。必须**等约 1.2s** 让 raw 模式先生效。
2. `onData` 只在「一次 read 的内容**恰好等于** `\r`」时才结束输入（`:96-98`），
   所以密码必须**逐字符**发送（间隔数十毫秒），不能整串 `send`。

```bash
# 建账号（在 apps/api 下，DATABASE_URL 指向隔离回放库；密码交互式输入，不走 argv）
DATABASE_URL="postgresql://epgs:epgs@localhost:5432/epgs_replay" expect /tmp/mkuser2.exp
# 授权（该 CLI 无交互提示，不需要 TTY）
npx ts-node --transpile-only src/access/access-cli.ts assign-access \
  --username dev --roles RULE_ADMIN,VIEWER --patient-detail
```

结果：账号 `dev`（显示名「回放验证」），角色 `{RULE_ADMIN,VIEWER}`，`patient_detail = t`；
登录实测 `POST /api/auth/login` → **HTTP 200**。

随后预设语义经**唯一正式入口**加载：`POST /api/attention-semantics/import-defaults`
→ `createdCount: 6`、`skippedCount: 0`、`updatedCount: 0`，并留下审计行
`ATTENTION_SEMANTIC_CREATE`，`actor_username = dev`。

| semantic_id | name | level | enabled | version | created_by |
| --- | --- | --- | --- | --- | --- |
| `b7ac4c80-acf1-4586-be0b-2816431e1461` | 明确或高度疑似恶性病变 | RED | true | 1 | dev |
| `7e78f67c-0a23-4b1c-a37c-ae080bd2f0f2` | 活动性出血或近期出血征象 | RED | true | 1 | dev |
| `226060c7-ba6c-4049-9818-79b8dd50bccd` | 性质待定、需活检或短期复查的病变 | YELLOW | true | 1 | dev |
| `c8a8cf43-6098-490d-b99b-69cc2cd89419` | 治疗后并发症或术后异常征象 | YELLOW | true | 1 | dev |
| `bd6fad04-3a6a-482b-a277-ddc91744f212` | 多发病变或累及范围广泛 | YELLOW | true | 1 | dev |
| `4e2fc7fa-1834-428e-823d-efd1ae0fc9e1` | 与既往检查相比出现变化 | GREEN | true | 1 | dev |

6 条全部启用。**没有**为了让结果好看去改这 6 条模板的内容，也没有新增第 7 条
（用的是仓库里既有的 `apps/api/src/attention-semantics/defaults.ts`）。

## 已固定的实验条件（下一轮沿用，勿改）

```text
dataset version      v1（frozen，2026-09-26）
dataset hash         cases.mjs 460143c7a451dbbeb3b258dc8df76d32512a52dd16c0f1aac08211a30976823a
git commit           a086c6c（main，已含数据集入库 PR #99；#96 修复为 c89f244）
                     数据集入库 commit da2c9d86f9e8f57d7b7289c0957ed9beca79e299（内容一致，
                     已核验 commit 内字节与冻结 hash 逐字节相同）
task version         classify-report/1（CLASSIFY_REPORT_PROMPT_VERSION）
prompt hash          classify-prompt.ts     38ddcd6b1685648c9b1cd8f627665bfb906733ceb3ee67054bcc0aa4af1716e5
                     classify-types.ts      90b151289e0cd4a8d9d700724664a4770bcdfee48ff2bf659877ec4628be2a9c
                     classify-report.ts     0b31ab5f447f3c18214ece8cb1c813f25bba5a085a47c66e90c062c2c4061cb3
env flags            SEMANTIC_REPORT_ENABLED  未设置（Joi 默认 false）→ 本轮计划置 true
                     SEMANTIC_JUDGE_ENABLED   未设置（Joi 默认 false）→ 本轮保持 false
                     SEMANTIC_MODEL_*         所有者已提供 → 见阻塞点 1（网络不可达）
semantic config      6 行（已加载预设，全部 enabled，version=1，created_by=dev）
                     明细见上文阻塞点 2 的表；加载后未再改动
run timestamp        n/a —— 未运行
```

回放库 `epgs_replay` 已按 §2 恢复到基线并实测通过（`--verify` 4/4）：
`monitor_record` 50 / `TEST-REPLAY` 50 / `monitor_match` 52 / `monitor_rule` 30（启用 30）/
`attention_semantic` 0 / `monitor_report_ai` 0 / `ai_attention_level` 非空 0 /
`ai_resolved_at` 非空 0；RED 15 / YELLOW 10 / UNCLASSIFIED 25。
`epgs` / `epgs_e2e` / `epgs_ui` 中 TEST-REPLAY 记录数均为 0。

## 还缺什么

**只剩一项：让本机能到达 `10.10.11.200:8080`**（接入院内网络或医院 VPN 后告知即可）。

账号与预设语义都已在位，`classify:once` 的另外两个前置条件已满足，其余步骤我已就绪：
恢复基线 → （预设已加载，跳过）→ 只置 `SEMANTIC_REPORT_ENABLED=true` → 跑 50 例 →
落逐例结果。

## 账号信息（仅用于本机隔离回放库 `epgs_replay`）

```text
用户名    dev        （显示名：回放验证）
角色      RULE_ADMIN, VIEWER      科室范围  全部      patient_detail  true
密码      不写入本文件 —— 避免日后随 results/ 一起入库；需重设见下
```

- 这只存在于**隔离回放库** `epgs_replay`（50 例纯虚构数据），与开发库 `epgs` 里的同名
  `dev` 账号**不是同一个**、密码也不同。
- 需要更换密码：`pnpm --filter api run auth:reset-password --username dev`（同样要 TTY，
  配方见 RUN-BLOCKED.md 阻塞点 2）。

## 本轮的安全事项（提请所有者注意）

1. **网关 `api_key` 已出现在聊天记录中**，建议本轮回放结束后轮换该 key。
2. `~/Downloads/README-codeagent-api.md` **含真实密钥**，**不得**提交进仓库；
   本目录与本轮任何入库文件都不含密钥（已逐字核对）。
