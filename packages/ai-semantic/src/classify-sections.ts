import {
  ClassifyReportInput,
  ReportAiField,
  REPORT_SECTION_ORDER,
  ReportSection,
} from './classify-types';

/**
 * Turn a report record into the ordered, non-empty sections the model is shown
 * (issue #88 §7).
 *
 * THREE DECISIONS WORTH STATING:
 *
 *  1. WHICH FIELDS. Only 检查项目 / 报告正文 / 诊断意见 - the text that carries
 *     meaning. Patient name, bed number, department, patient type and exam time
 *     are NOT included: they cannot tell the model whether a report expresses a
 *     meaning, and putting identifiers on the wire for nothing is exactly the
 *     kind of unnecessary exposure the data dictionary forbids.
 *
 *  2. VERBATIM, NOT TRIMMED. The text is passed through exactly as stored, so an
 *     evidence offset computed against it indexes straight into the
 *     monitor_record column. Trimming here would shift every offset by however
 *     much whitespace was removed.
 *
 *  3. EMPTY FIELDS ARE OMITTED, not sent as blanks. A section containing only
 *     whitespace is treated as absent - asking a model to interpret a blank
 *     invites it to invent something to say about it. If all three are empty the
 *     caller gets an empty array and reports EMPTY_INPUT without calling.
 */
export function deriveReportSections(input: ClassifyReportInput): ReportSection[] {
  const byField: Record<ReportAiField, string | null | undefined> = {
    EXAM_ITEM: input.examItem,
    FINDINGS: input.reportContent,
    IMPRESSION: input.diagnosis,
  };

  const sections: ReportSection[] = [];
  for (const field of REPORT_SECTION_ORDER) {
    const text = byField[field];
    if (typeof text !== 'string' || text.trim().length === 0) {
      continue;
    }
    sections.push({ field, text });
  }
  return sections;
}
