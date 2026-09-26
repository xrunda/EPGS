import type { MonitorAttentionSourceDto } from '@epgs/shared-types';

/**
 * 「这条记录为什么在关注列表里」（issue #88）的医生语言，供工作台列表与详情抽屉
 * 共用。
 *
 * 单独一个模块、而不是塞进 highlight.tsx：那个文件同时被预警 H5 页面（issue #72）
 * 引用，而 H5 是被通知形态冻结的面，不该因为它没用到就被动跟着 AI 的词汇走。
 *
 * 徽标一律是纯文字，且不给等级标签上色 —— 颜色不是唯一的信息通道。
 */
export const SOURCE_LABELS: Record<MonitorAttentionSourceDto, string> = {
  RULE: '关键词',
  AI_REPORT: 'AI 语义',
  BOTH: '关键词 + AI 语义',
  NONE: '',
};

export const SOURCE_TITLES: Record<MonitorAttentionSourceDto, string> = {
  RULE: '关注等级来自关键词命中',
  AI_REPORT: '关注等级来自整份报告的语义判读，关键词没有命中',
  BOTH: '关键词与语义判读都发现了需要关注的内容',
  NONE: '',
};

/**
 * 关注等级在业务上的说法 —— **全应用唯一一份**。RED / YELLOW / GREEN 是管理上的
 * 「关注等级」（要多久看到），不是临床严重程度或诊断分级，所以必须带「关注」二字。
 *
 * 引用处只有两个文件（共五处）：详情抽屉的「AI 语义发现」等级标签，以及 AI 语义
 * 监控页的池标题 / 表格行内标签 / 表单等级卡片 / 筛选下拉（SemanticMonitorModal 把它
 * 别名成 POOL_LABELS）。上一轮就是在那一页漏改了三处，所以等级文案只有一个来源。
 *
 * 注意与 highlight.tsx 的 LEVEL_LABELS 不同：那个映射的输出是「红色」，被预警 H5
 * 页面复用并在那里自己拼上「关注」二字（AlertApp 渲染「{level}关注」）。这里不能
 * 改那一个，否则 H5 会变成「红色关注关注」。
 */
export const ATTENTION_LEVEL_LABELS = {
  RED: '红色关注',
  YELLOW: '黄色关注',
  GREEN: '绿色关注',
} as const;
