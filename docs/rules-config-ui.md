# 监测规则配置界面（Issue #11）

前端通过主工作台的“监测规则”按钮打开居中弹窗，不切换路由，因此关闭后不会改变主页面的筛选与浏览上下文。页面文案统一使用“关注等级”，红、黄、绿仅表示关键词规则产生的关注标记。

## 功能

- 按关键词、关注等级和启停状态筛选，列表采用每页 20 条的服务端分页。
- 新增、编辑和启停规则；编辑与启停请求携带当前 `version`，用于乐观锁校验。
- CSV 批量导入分为预校验和确认写入两个阶段，可下载模板，并展示合法行和错误行。
- 关闭弹窗或编辑面板前检查未保存内容。
- `canManageRules=false` 时隐藏新增和导入入口，列表操作显示为只读。
- 提供加载、空数据、请求失败、保存成功及冲突错误状态。

规则修改只影响后续新数据，不触发历史数据重算。关键词匹配和规则冲突的最终判定均由后端完成。

## API 与配置

界面复用 `docs/rules-api.md` 定义的接口：

- `GET /api/rules`
- `POST /api/rules`
- `PUT /api/rules/{id}`
- `POST /api/rules/import/validate`
- `POST /api/rules/import/confirm`

API 地址读取 `VITE_API_BASE_URL`，未配置时使用 `http://localhost:3000`。当前后端尚未完成正式身份鉴权，前端临时使用 `actorId=web-operator`；接入身份功能后应改为当前登录用户标识。

“操作日志”按钮当前为禁用提示入口。访问审计和服务端写权限由 Issue #13 实现，前端只读模式不能替代服务端授权。

## CSV 模板

模板为 UTF-8 CSV，字段如下：

```csv
keyword,level,matchField,matchMode,category,notes
癌,RED,REPORT_TEXT,CONTAINS,,示例规则
```

服务端允许的枚举及详细错误格式以 `docs/rules-api.md` 为准。

## 验证

```bash
pnpm --filter @epgs/web test
pnpm --filter @epgs/web typecheck
pnpm --filter @epgs/web lint
pnpm --filter @epgs/web build
```
