import { AttentionLevelDto } from '@epgs/shared-types';

/** One preset attention semantic offered by `POST /api/attention-semantics/import-defaults`. */
export interface DefaultAttentionSemantic {
  name: string;
  description: string;
  attentionLevel: AttentionLevelDto;
}

/**
 * Preset attention semantics (issue #88).
 *
 * WHAT THESE ARE: a starting point for a hospital that has not written its own
 * yet - plain-language statements of meanings worth being told about, phrased
 * the way the classifier is asked to read them (a report expresses this
 * MEANING, not "this word appears").
 *
 * WHAT THESE ARE NOT, and the three things that follow from that:
 *
 *  1. NOT A MEDICAL STANDARD. They are generic endoscopy wording written for
 *     this system, not a guideline from any college or hospital, and not a
 *     validated clinical instrument. The grade a hospital gives a meaning is a
 *     management attention level - how much noise it is willing to tolerate -
 *     and NOT a statement about severity. Every one of these must be reviewed
 *     and adapted by the hospital before it goes into service, which is why the
 *     config UI shows that warning next to the load button.
 *
 *  2. NOT WRITTEN BY A MIGRATION. Owner decision: schema migrations must never
 *     write medical configuration. A loaded default becomes this hospital's
 *     config only when a human presses the button, and the audit row records
 *     who did. Until then the hospital has no AI semantics at all, and the
 *     classifier correctly reports NO_SEMANTICS rather than silently judging
 *     reports against someone else's wording.
 *
 *  3. NOT FROZEN. Importing copies these values into ordinary
 *     AttentionSemantic rows. Editing one afterwards versions the row normally;
 *     nothing here is re-read at classify time. Changing this file does NOT
 *     change any hospital's existing configuration - which is the point: a code
 *     change must not silently re-colour reports a doctor already reviewed.
 *
 * WHY THE DESCRIPTIONS ARE PHRASED AS EVIDENCE: each one names the kind of
 * report content that would justify it. That is what the classifier is shown,
 * so a description that only states a conclusion ("病人很严重") gives it nothing
 * to match against and would produce confident nonsense.
 *
 * IDs are deliberately absent: each import creates its own rows, so two
 * hospitals loading the same preset get different ids and neither can
 * invalidate the other's audit trail.
 */
export const DEFAULT_ATTENTION_SEMANTICS: readonly DefaultAttentionSemantic[] = [
  {
    name: '明确或高度疑似恶性病变',
    attentionLevel: 'RED',
    description:
      '报告描述了提示恶性或高度可疑恶性的表现，例如：不规则隆起或溃疡、边缘隆起呈堤状、表面糜烂质脆触之易出血、管腔狭窄僵硬、黏膜皱襞中断破坏、病变浸润感，或诊断意见中给出明确的恶性倾向判断。整体含义已指向恶性，而不仅是出现某个字眼。',
  },
  {
    name: '活动性出血或近期出血征象',
    attentionLevel: 'RED',
    description:
      '报告描述了正在出血或新近出血的表现，例如：活动性渗血、喷射性出血、明确出血点、血凝块附着、Forrest Ia/Ib 级，或操作中因出血而需要止血处理。需要尽快人工确认。',
  },
  {
    name: '性质待定、需活检或短期复查的病变',
    attentionLevel: 'YELLOW',
    description:
      '报告发现了尚未定性的病变，或明确建议活检、病理确认、短期复查，例如：性质待定的隆起或溃疡、可疑早癌、需病理确认的黏膜改变、建议随访复查的病灶。含义是"还没有结论、需要跟进"，而不是已经确诊。',
  },
  {
    name: '治疗后并发症或术后异常征象',
    attentionLevel: 'YELLOW',
    description:
      '报告描述了治疗后或术后可能出现的并发症线索，例如：吻合口异常、狭窄、瘘、穿孔或可疑穿孔、创面愈合不良、术后出血。需要关注是否需要临床干预。',
  },
  {
    name: '多发病变或累及范围广泛',
    attentionLevel: 'YELLOW',
    description:
      '报告提示病变为多发、累及多个部位，或范围较长、面积较大，例如：多发息肉、散在多发糜烂、病变累及范围广、累及长度较长。含义是病变负荷较大，可能影响后续处理安排。',
  },
  {
    name: '与既往检查相比出现变化',
    attentionLevel: 'GREEN',
    description:
      '报告明确与既往检查做了比较并指出发生变化，例如：较前增大、较前增多、新发、较前缩小或好转。含义是纵向变化值得留意，通常不需要立即处理。',
  },
];
