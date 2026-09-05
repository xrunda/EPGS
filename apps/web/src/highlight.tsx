import type { ReactNode } from 'react';
import type { MatchFieldDto, MonitorLevelDto } from '@epgs/shared-types';

/**
 * Hit-evidence presentation helpers shared by the workbench DetailDrawer and
 * the WeCom alert H5 page (issue #72) - extracted verbatim from DetailDrawer
 * so both surfaces highlight the same way.
 */

export const LEVEL_LABELS: Record<MonitorLevelDto, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
  UNCLASSIFIED: '未分级',
};

/** Where the hit was found in the report (mirrors the issue #8 API doc mapping). */
export const FIELD_LABELS: Record<MatchFieldDto, string> = {
  FINDINGS: '报告内容',
  IMPRESSION: '诊断',
  REPORT_TEXT: '报告内容与诊断',
  STUDY_DESCRIPTION: '检查项目',
  OTHER: '其他',
};

/** Fields whose hits are highlighted inside 报告内容. */
export const REPORT_TEXT_FIELDS: MatchFieldDto[] = ['FINDINGS', 'REPORT_TEXT', 'OTHER'];

/** Fields whose hits are highlighted inside 诊断. */
export const DIAGNOSIS_TEXT_FIELDS: MatchFieldDto[] = ['IMPRESSION', 'REPORT_TEXT', 'OTHER'];

/**
 * Splits `text` into React nodes, wrapping every case-insensitive occurrence of
 * any `keywords` in a <mark>. Overlapping matches are merged. The original text
 * is only sliced into nodes, never rewritten, so highlighting cannot corrupt it
 * (issue #10: "命中词高亮不修改报告原文").
 */
export function highlightSegments(text: string, keywords: string[]): ReactNode[] {
  const lowered = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const keyword of keywords) {
    const lowerKeyword = keyword.toLowerCase();
    let from = 0;
    let index = lowered.indexOf(lowerKeyword, from);
    while (index !== -1) {
      ranges.push([index, index + keyword.length]);
      from = index + keyword.length;
      index = lowered.indexOf(lowerKeyword, from);
    }
  }
  if (ranges.length === 0) return [text];

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push(range);
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  merged.forEach(([start, end], index) => {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark key={index} className="hit-highlight">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Distinct keywords to highlight in a text field, from the hits that matched there. */
export function keywordsFor(
  hits: { matchedField: MatchFieldDto; keyword: string }[],
  fields: MatchFieldDto[],
): string[] {
  return Array.from(
    new Set(hits.filter((hit) => fields.includes(hit.matchedField)).map((hit) => hit.keyword)),
  );
}
