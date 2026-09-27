import type { MonitorAttentionSourceDto } from '@epgs/shared-types';

/**
 * 「这条依据是哪一路发现的」的图标（issue #112）。
 *
 * 医生看到的「关注依据」是两路合并的结果：关键词命中（报告文字里出现了规则词）和
 * 整份报告读出来的发现。合并以前只能靠两个很弱的形态差异去猜 —— 列表行的理由是
 * 一句话，抽屉里看卡片右上角写的是列名（关键词命中）还是「把握高 / 把握中」（报告级
 * 发现）。同一份报告两路各出一条时，两张卡长得几乎一样。
 *
 * issue #94 曾经把每行一个「AI 语义」的**文字徽标**从医生视图里拿掉，理由是医生要
 * 回答的是「为什么需要关注」，不是「哪个引擎发现了他」；那条规矩由 attentionReason.ts
 * 的理由句承担，现在仍然成立。这里请回来的是**图标**，不是词：图标本身不产生渲染文本，
 * 两处术语扫描（Workbench.test.tsx / DetailDrawer.test.tsx 的机制词禁列）照旧通过。
 *
 * 但悬停提示是**会显示成文字的**，而且所有者 2026-09-27 定了它要跟设置入口同名
 * （「关键词命中」「AI 语义命中」对应顶栏的「关键词监控」「AI 语义监控」）——
 * 也就是说提示里**故意**带着「关键词 / AI / 语义」这三个词。这是所有者的决定：
 * 入口的名字就是这套词，图标提示跟它对齐，医生在顶栏见过的词和滑出来的词是同一套。
 * `alt` 不跟着改，它要接「关注理由」那句话。两套说法的分工写在各自的注释与测试里。
 *
 * 图标本身由所有者提供（放大镜扫文字 = 关键词命中，节点 + 气泡 = 报告级发现）。
 * 原始 PNG 是 665×665、各约 140KB，直接缩到 22px 时两圈外环吃掉四成直径、里面糊成
 * 一团，所以这里存的是**裁掉两圈外环、只留中间图形**的 64×64 版本（各约 8KB，
 * 覆盖 32px 以内的两倍图）。换回整枚徽章只需替换 apps/web/public 下这两个文件，
 * 代码不动。
 */

export interface FindingSourceIcon {
  /** `/` 开头，走 apps/web/public（与 hospital-logo.jpg 同处）。 */
  src: string;
  /**
   * 无障碍名称。刻意用界面里已有的说法：列表的「关注理由」列写的就是
   * 「命中「溃疡」；报告提示「…」」，读屏软件连着后面那列读下来是通顺的。
   * 不用 alt="" 把图标藏掉 —— 它承载的信息（哪一路发现的）在别处没有等价文本。
   */
  alt: string;
  /**
   * 鼠标悬停时的文字提示。两枚图标是自解释的图形，但医生第一次看到只会觉得
   * 「这里有个图标」—— 得有一句话告诉他这枚代表什么。
   *
   * 措辞跟着**设置入口的按钮**走（所有者 2026-09-27 定）：那排按钮叫「关键词监控」
   * 「AI 语义监控」，所以这里叫「关键词命中」「AI 语义命中」，医生在顶栏见过的词
   * 和鼠标滑出来的词是同一套。
   *
   * 与 `alt` 刻意不同：`alt` 跟着列表「关注理由」那句话读（那边写的是
   * 「命中「溃疡」；报告提示「…」」），得短、得接得上；提示是悬停时单独读的一行，
   * 要的是跟设置入口对得上。两个受众、两套说法，见 findingSource.test.ts 的分开断言。
   */
  tip: string;
}

/** 关键词命中：报告正文里的规则词。 */
export const KEYWORD_SOURCE_ICON: FindingSourceIcon = {
  src: '/finding-keyword.png',
  alt: '命中',
  tip: '关键词命中',
};

/** 整份报告读出来的发现。 */
export const REPORT_SOURCE_ICON: FindingSourceIcon = {
  src: '/finding-ai.png',
  alt: '报告提示',
  tip: 'AI 语义命中',
};

/**
 * 记录级的来源 → 图标。`NONE` 返回空数组：这一路都没有，就没有图可以画，由调用方
 * 渲染占位符（留空会被读成「没渲染出来」）。
 *
 * 判定本身不在前端：`attentionSource` 由服务端 `toAttentionSource()` 统一算出
 * （apps/api/src/monitor/report-ai.mapper.ts），前端只做映射，不重新判一次。
 */
export function findingSourceIcons(source: MonitorAttentionSourceDto): FindingSourceIcon[] {
  switch (source) {
    case 'RULE':
      return [KEYWORD_SOURCE_ICON];
    case 'AI_REPORT':
      return [REPORT_SOURCE_ICON];
    case 'BOTH':
      return [KEYWORD_SOURCE_ICON, REPORT_SOURCE_ICON];
    default:
      return [];
  }
}
