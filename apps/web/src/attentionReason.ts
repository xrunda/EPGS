import type {
  MatchFieldDto,
  MonitorAttentionSourceDto,
  MonitorExamHitDto,
  MonitorExamWorkbenchDetailDto,
  MonitorExamWorkbenchDto,
  MonitorLevelDto,
} from '@epgs/shared-types';

/**
 * 「这位患者为什么需要关注」的一句话说明（issue #94），供工作台列表与详情抽屉共用。
 *
 * 完全由现有字段确定性拼出 —— 不调用模型、不新增字段、不新增一次请求。句子的主语
 * 永远是「报告里 / 诊断里有什么」，不是「哪条机制发现了它」：这里一个机制词都不出现，
 * 工作台与抽屉的渲染文本术语扫描盯着的就是这一点。
 *
 * 没有理由时返回 null，由调用方渲染占位符 —— 没有理由就不编造理由。
 */

/**
 * 命中所在位置在句子里的说法。取自 highlight.tsx 的 FIELD_LABELS（同一批医生用词），
 * 但取值要接得上「中发现「…」」：两个字段都查的 REPORT_TEXT 说成「报告内容或诊断」，
 * 没有独立文本源、只作兜底的 OTHER 直接并入「报告」。
 */
const LOCATION_LABELS: Record<MatchFieldDto, string> = {
  FINDINGS: '报告内容',
  IMPRESSION: '诊断',
  REPORT_TEXT: '报告内容或诊断',
  STUDY_DESCRIPTION: '检查项目',
  OTHER: '报告',
};

/** 「等 N 处」：一句只点一条，多于一条时说清还有别的，免得医生把这一句当成全部。 */
function moreCount(total: number): string {
  return total > 1 ? `等 ${total} 处` : '';
}

/**
 * 关键词一侧的句子。优先点名与记录当前等级同级的那条命中 —— 这句话要解释的是屏幕上
 * 那个等级，不是随便一条命中；没有同级命中时退回第一条。一条有效命中都没有则返回
 * null（调用方已经先滤掉「未计入关注」的命中，它们不解释等级）。
 */
function keywordClause(hits: MonitorExamHitDto[], level: MonitorLevelDto): string | null {
  if (hits.length === 0) return null;
  const primary = hits.find((hit) => hit.level === level) ?? hits[0];
  return `${LOCATION_LABELS[primary.matchedField]}中发现「${primary.keyword}」${moreCount(hits.length)}`;
}

/**
 * 报告级发现那一侧的句子。名字只有详情接口才有（列表不返回任何 AI 内容），所以它是
 * 可选参数：两种形态都从同一个模板出来，措辞不会分叉。
 *
 * `NONE` / `RULE` 返回 null —— 这一侧没有发现时，理由句里就不该有它。
 */
function reportClause(source: MonitorAttentionSourceDto, name: string | null): string | null {
  if (source !== 'AI_REPORT' && source !== 'BOTH') return null;
  return name === null ? '报告提示需要关注' : `报告提示「${name}」`;
}

function joinClauses(clauses: Array<string | null>): string | null {
  const parts = clauses.filter((clause): clause is string => clause !== null);
  return parts.length > 0 ? parts.join('；') : null;
}

/** 详情抽屉的理由句：命中位置 + 命中词，必要时再补报告级发现。 */
export function attentionReason(detail: MonitorExamWorkbenchDetailDto): string | null {
  return joinClauses([
    keywordClause(
      detail.hits.filter((hit) => !hit.semanticFiltered),
      detail.monitorLevel,
    ),
    reportClause(detail.attentionSource, detail.aiSemantics[0]?.name ?? null),
  ]);
}

/**
 * 工作台行内的理由句。行内没有命中所在列（issue #94 决定不为此新增标量字段），所以
 * 只说到「命中『X』」为止；报告级发现的名字也不在列表响应里，只能说明有这一侧。
 *
 * 行内的 `matchedKeywords` 已经是**计入关注**的关键词（列表查询就滤掉了不计入的
 * 命中），与等级同源。
 */
export function rowAttentionReason(exam: MonitorExamWorkbenchDto): string | null {
  const keywords = exam.matchedKeywords;
  return joinClauses([
    keywords.length === 0 ? null : `命中「${keywords[0]}」${moreCount(keywords.length)}`,
    reportClause(exam.attentionSource, null),
  ]);
}
