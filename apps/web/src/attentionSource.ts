import type { MonitorLevelDto } from '@epgs/shared-types';

/**
 * 关注等级的医生语言 —— **全应用唯一一份**（issue #88 建立，issue #94 收敛到只剩等级）。
 *
 * 单独一个模块、而不是塞进 highlight.tsx：那个文件同时被预警 H5 页面（issue #72）
 * 引用，而 H5 是被通知形态冻结的面，不该因为它没用到就被动跟着这里的词汇走。
 *
 * issue #94 之后这里不再有来源徽标（关键词 / AI 语义 / 关键词 + AI 语义）：医生在
 * 临床上要回答的是「为什么需要关注」，不是「哪个引擎发现了他」—— 那句话由
 * attentionReason.ts 从同一批数据拼出。`attentionSource` 字段仍留在 API 契约上
 * （运营/审计视图要用），去掉的只是医生看到的展示。
 */

/**
 * RED / YELLOW / GREEN 是管理上的「关注等级」（要多久看到），不是临床严重程度或诊断
 * 分级，所以必须带「关注」二字。
 *
 * 引用处：工作台的列表行内标签、详情抽屉的主等级标签与「关注依据」里每条依据的等级
 * 标签，以及 AI 语义监控页的池标题 / 表格行内标签 / 表单等级卡片 / 筛选下拉
 * （SemanticMonitorModal 把它别名成 POOL_LABELS）。几处都从同一个映射取值，所以不会
 * 再出现同一屏里「红色」与「红色关注」并存。上一轮就是在那一页漏改了三处。
 *
 * UNCLASSIFIED 不是关注等级，说法是「未分级」；它在这里只为让映射能吃下整份
 * MonitorLevelDto（记录等级、命中等级都可能取到它），调用方不必再判一次空。
 *
 * 注意与 highlight.tsx 的 LEVEL_LABELS 不同：那个映射的输出是「红色」，被预警 H5
 * 页面复用并在那里自己拼上「关注」二字（AlertApp 渲染「{level}关注」）。这里不能
 * 改那一个，否则 H5 会变成「红色关注关注」。
 */
export const ATTENTION_LEVEL_LABELS: Record<MonitorLevelDto, string> = {
  RED: '红色关注',
  YELLOW: '黄色关注',
  GREEN: '绿色关注',
  UNCLASSIFIED: '未分级',
};
