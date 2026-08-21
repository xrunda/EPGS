# EPGS 规则管理 API（issue #4）

本文档描述 `apps/api/src/rules/` 实现的 `monitor_rule` CRUD API：查询、新增、
编辑、启停、CSV 批量导入。供监测服务（issue #5/#6）与配置弹窗（issue #11）
共用。字段级含义参见 `apps/api/prisma/schema.prisma` 与
`docs/data-dictionary.md` 的 `monitor_rule` 章节 —— 本文档只补充 HTTP 层的
请求/响应约定，不重复字段定义。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`
（`@nestjs/swagger`，见 `apps/api/src/main.ts`）。本文档是对其的手写补充，
着重说明业务规则和示例，而非逐字段类型清单。

## 鉴权（占位）

本 issue 尚无正式鉴权系统（issue #13 负责）。所有写接口（`POST`/`PUT`/
`import/*`）已挂载 `RulesWriteGuard`
(`apps/api/src/common/guards/rules-write.guard.ts`)，当前实现**放行所有请求**，
仅作为未来接入真实鉴权的挂载点。调用方必须显式传入 `actorId`
（操作人标识，字符串，非结构化）用于审计字段 `createdBy`/`updatedBy` ——
这不是身份验证，只是审计记录，真正的越权拦截要等 issue #13。

## 统一错误格式

复用 issue #1 的全局异常过滤器，所有错误响应形如：

```json
{
  "error": {
    "code": "RULE_CONFLICT",
    "message": "...",
    "correlationId": "...",
    "details": { "conflictingRuleId": "..." }
  }
}
```

`details` 为可选字段，仅部分错误码（见下表）携带机器可读的额外上下文。

| 错误码 | HTTP 状态 | 触发场景 |
|---|---|---|
| `RULE_CONFLICT` | 409 | 新增/编辑后与另一条已启用规则的 (keyword, level, matchField, matchMode) 元组重复 |
| `RULE_VERSION_CONFLICT` | 409 | `PUT` 请求的 `version` 与数据库当前版本不一致（乐观锁），或目标行已被语义化编辑取代 |
| `RULE_NOT_FOUND` | 404 | 规则 id 不存在 |
| `IMPORT_FILE_INVALID` | 400 | CSV 文件为空、编码非 UTF-8、缺少必需列或格式错误 |
| `IMPORT_FILE_MISSING` | 400 | `import/validate` 未上传 `file` 字段 |
| `IMPORT_TOKEN_INVALID` | 400 | `import/confirm` 的 `importToken` 不存在或已过期（15 分钟 TTL） |
| `IMPORT_NO_VALID_ROWS` | 400 | 校验批次中没有任何合法行 |
| `IMPORT_CONFIRM_CONFLICT` | 400 | 确认写入时，某些行与 confirm 时刻的最新数据库状态冲突（整批不写入） |
| （class-validator 校验失败）| 400 | 非法枚举、空白关键词等，`message` 为 class-validator 的字段级错误信息 |

## 业务规则

- **唯一性判定口径：全局，不分科室。** issue 原文提到"同一科室、关键词、
  匹配范围和方式的启用规则不得重复"，但 issue #3 已合并的 `MonitorRule`
  schema 中没有"科室"字段（只有自由文本的 `category`，非外键，且非查重维度）。
  因此本实现按**全局**唯一性判定：同一 `(keyword, level, matchField,
  matchMode)` 元组，在所有**已启用**规则中只能存在一条，不区分科室。这是
  与 issue 文字表述的已知偏离，详见 PR 描述。
- 关键词比较**大小写不敏感**（含查重与冲突检测），满足 "'Ca' 默认不区分
  大小写" 的要求；`matchMode=EXACT_PHRASE`（即 schema 中的 `EXACT`）时同样
  不敏感——大小写敏感度目前不是可配置维度。
- 保存前校验：空白关键词（去空格后长度为 0）拒绝；非法枚举值（`level`/
  `matchField`/`matchMode`）拒绝；与现有启用规则冲突时返回 `RULE_CONFLICT`
  并附 `conflictingRuleId`。
- 规则变更**默认仅影响后续数据**：本 API 不做历史 `monitor_match` 重算，
  也不提供触发重算的接口——按 issue 要求不在本 issue 范围内。

## 乐观锁与版本化审计

`MonitorRule.version` 承担两个职责：

1. **乐观锁**：每次 `PUT` 必须携带调用方读到的 `version`。写入时用
   `UPDATE ... WHERE id = ? AND version = ?` 语义（Prisma `updateMany` +
   受影响行数校验），不匹配立即返回 `409 RULE_VERSION_CONFLICT`
   （附 `details.expectedVersion`/`details.actualVersion`）。**每次成功的
   编辑都会递增 `version`**——包括不改变匹配语义的编辑（如仅停用、改备注），
   否则两个操作人并发地做非语义编辑（如都基于旧读数停用规则）时无法被
   乐观锁探测到。这是比 schema 注释字面更严格的解读，详见 PR 描述。
2. **版本化审计**：编辑 `keyword`/`level`/`matchField`/`matchMode`
   任一字段（"改变匹配语义"）时，服务层**新建一行**（新 `id`，
   `version = 旧版本 + 1`，同一 `ruleGroupId`），并将旧行置为
   `isEnabled = false`，而不是原地覆盖——这样历史 `monitor_match` 行
   引用的规则版本永远可追溯。仅改 `category`/`notes`/`isEnabled`
   （不改匹配语义）时原地更新同一行（id 不变），但仍递增 `version`（见上）。
   编辑一条已被语义化编辑取代的旧版本行（即该行不再是其 `ruleGroupId`
   内 `version` 最大的行）会被拒绝为 `RULE_VERSION_CONFLICT`，防止在
   死历史上意外分叉出第二条编辑链。

## 接口

### `GET /api/rules`

按 `keyword`（子串，大小写不敏感）、`level`、`isEnabled`、`category`
筛选，分页（`page` 默认 1，`pageSize` 默认 20，上限 200）。

```
GET /api/rules?keyword=%E8%82%BF%E7%98%A4&level=RED&isEnabled=true&page=1&pageSize=20
```

响应：

```json
{
  "items": [
    {
      "id": "b5c46a86-b57a-4c88-8515-44da23a5d5c4",
      "keyword": "肿瘤",
      "level": "RED",
      "matchField": "REPORT_TEXT",
      "matchMode": "CONTAINS",
      "category": null,
      "isEnabled": true,
      "version": 1,
      "ruleGroupId": "b5c46a86-b57a-4c88-8515-44da23a5d5c4",
      "notes": null,
      "createdAt": "2026-08-21T05:30:00.000Z",
      "updatedAt": "2026-08-21T05:30:00.000Z",
      "createdBy": "system-seed",
      "updatedBy": "system-seed"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### `GET /api/rules/{id}`

返回单条规则；不存在返回 `404 RULE_NOT_FOUND`。

### `POST /api/rules`

```json
{
  "keyword": "肿瘤",
  "level": "RED",
  "matchField": "REPORT_TEXT",
  "matchMode": "CONTAINS",
  "category": null,
  "notes": null,
  "isEnabled": true,
  "actorId": "zhang.san"
}
```

`matchMode` 缺省为 `CONTAINS`，`isEnabled` 缺省为 `true`。成功返回
`201` 及创建后的规则（`version=1`，`ruleGroupId` 等于自身 `id`）。
与现有启用规则冲突返回 `409 RULE_CONFLICT`。

### `PUT /api/rules/{id}`

```json
{
  "version": 1,
  "keyword": "恶性肿瘤",
  "isEnabled": true,
  "actorId": "li.si"
}
```

所有业务字段可选，但 `version` 与 `actorId` 必填。返回更新后的规则——
若触发版本化，返回的 `id` 与请求路径中的 `id` **不同**（新版本行），
`ruleGroupId` 与旧行一致。

### `POST /api/rules/import/validate`

`multipart/form-data`，字段名 `file`，CSV，UTF-8 编码，最大 5 MiB。

必需列：`keyword`、`level`、`matchField`（列名大小写/顺序不敏感）。
可选列：`matchMode`（缺省 `CONTAINS`）、`category`、`notes`。

```csv
keyword,level,matchField,matchMode
癌,RED,REPORT_TEXT,CONTAINS
肿瘤,RED,REPORT_TEXT,CONTAINS
```

响应（不写库）：

```json
{
  "importToken": "b1f2...uuid",
  "totalRows": 2,
  "validRows": 2,
  "errors": [],
  "preview": [
    { "line": 2, "keyword": "癌", "level": "RED", "matchField": "REPORT_TEXT", "matchMode": "CONTAINS" },
    { "line": 3, "keyword": "肿瘤", "level": "RED", "matchField": "REPORT_TEXT", "matchMode": "CONTAINS" }
  ]
}
```

部分失败示例（`errors` 中每行含具体原因，`line` 为文本编辑器视角的行号，
表头为第 1 行）：

```json
{
  "importToken": "...",
  "totalRows": 3,
  "validRows": 1,
  "errors": [
    { "line": 2, "message": "keyword must not be blank" },
    { "line": 3, "message": "level \"BAD_LEVEL\" is not a valid MonitorLevel (RED, YELLOW, GREEN, UNCLASSIFIED)" }
  ],
  "preview": [ /* 仅合法行 */ ]
}
```

文件为空、非 UTF-8 编码或缺少必需列时，整个请求返回
`400 IMPORT_FILE_INVALID`（不返回逐行错误，因为连表头都无法解析）。

### `POST /api/rules/import/confirm`

```json
{ "importToken": "b1f2...uuid", "actorId": "zhang.san" }
```

将 `validate` 阶段判定合法的行在**单个事务**中写入。若确认写入时（可能
与 validate 时刻已有时间差）发现某行与数据库当前状态冲突，则**整批不写入**
并返回 `400 IMPORT_CONFIRM_CONFLICT`（不做部分写入，避免"导入了一半"的
不确定状态）。`importToken` 一次性使用（confirm 后立即失效），15 分钟未
确认自动过期。

## 初始红色关键词种子

`apps/api/prisma/seed.ts` 建立 issue 原文列出的 6 条初始红色关键词：
癌、肿瘤、肿物、Ca、食管裂孔疝、贲门失弛缓症（均为 `level=RED`，
`matchField=REPORT_TEXT`，`matchMode=CONTAINS`）。运行方式：

```bash
DATABASE_URL=postgresql://... pnpm --filter api exec prisma db seed
# 或
DATABASE_URL=postgresql://... pnpm --filter api exec ts-node --transpile-only prisma/seed.ts
```

幂等：重复运行会跳过已存在的关键词（按大小写不敏感的
keyword+level+matchField+matchMode 元组判断），不产生重复行。

**黄色、绿色关键词首批词库本 issue 不建立**——按 issue 原文"黄绿词库留空或
用占位示例，在文档中说明待业务确认"，本实现选择完全留空（不导入任何
占位示例数据），等待内镜中心确认后由业务方通过 `POST /api/rules` 或
CSV 导入接口自行建立。

## 测试

- 单元测试（mock Prisma，无需数据库）：`apps/api/src/rules/**/*.spec.ts`、
  `apps/api/src/common/guards/rules-write.guard.spec.ts`。
- 端到端测试（需要真实 Postgres，已应用 issue #3 迁移）：
  `apps/api/test/rules.e2e-spec.ts`，覆盖完整生命周期、重复冲突、并发修改
  （含"语义编辑后旧行仍被引用"与"两个操作人都基于旧版本做非语义编辑"两类
  竞态）、非法枚举、CSV 导入的全成功/部分失败/文件内重复行/编码错误/空文件
  场景。该文件在检测不到可用 Postgres 时，每个用例会直接判定通过（no-op），
  不会导致 issue #1 的无数据库 CI 任务失败；CI 中真正执行在 `.github/
  workflows/ci.yml` 的 `db-migrations` job。

本地验证 real Postgres 的临时实例创建方式：

```bash
initdb -D /tmp/epgs-pgdata -U epgs --auth=trust -E UTF8
pg_ctl -D /tmp/epgs-pgdata -o "-p 5544 -k /tmp" -l /tmp/epgs-pg.log start
createdb -h /tmp -p 5544 -U epgs epgs
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec prisma migrate deploy
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec jest --config ./test/jest-e2e.json test/rules.e2e-spec.ts
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec ts-node --transpile-only prisma/seed.ts
pg_ctl -D /tmp/epgs-pgdata stop
rm -rf /tmp/epgs-pgdata /tmp/epgs-pg.log
```

## 待确认事项（本 issue 不擅自决定）

1. **规则唯一性是否真的需要按科室隔离？** 见上文"业务规则"一节——当前实现
   为全局唯一，与 issue 文字的"同一科室"表述不一致，因为已合并的 schema
   未建模科室维度。若业务确需按科室隔离，需要先给 `MonitorRule` 加科室
   字段（新 issue/schema 迁移），不宜在本 issue 内追加。
2. 黄色、绿色关键词首批词库内容，需内镜中心确认后再通过 API/导入建立。
3. 是否需要为 `(keyword, level, match_field, match_mode) WHERE is_enabled`
   增加数据库层局部唯一索引，以完全消除服务层应用级检查在高并发下的
   竞态窗口（当前用同事务内查后写收窄但不能完全消除，见
   `RulesService.assertNoConflict` 的代码注释）。
