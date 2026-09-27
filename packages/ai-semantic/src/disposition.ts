import {
  SemanticConfidence,
  SemanticDecisionReason,
  SemanticDisposition,
  ValidateMatchVerdict,
} from './types';

/**
 * THE DECISION MATRIX (issue #87 §7).
 *
 * This is the only place in the system where "may this keyword hit be removed
 * from the attention result" is answered, and it is a pure function that
 * cannot see the model, the network, the database or the clock. It takes the
 * validated verdict fields and returns a decision. The model's own opinion
 * about filtering is never solicited and never read.
 *
 * THE TABLE, and why each row is what it is:
 *
 *   PRESENT               -> KEEP    The report says it is there. Obviously a hit.
 *   SUSPECTED             -> KEEP    "考虑...可能" / "不能除外" is a doctor raising
 *                                    a possibility, which is precisely someone
 *                                    the monitoring should reach. Ambiguity is
 *                                    not absence, and treating a maybe as a no
 *                                    would be the most dangerous possible
 *                                    filter.
 *   UNCERTAIN             -> KEEP    The model could not tell. Unreadable is not
 *                                    the same as negative; a hit is never
 *                                    removed because a model shrugged.
 *   NEGATED + HIGH        -> FILTER  "未见明显溃疡" with high confidence is the
 *                                    canonical false positive this issue
 *                                    exists to remove.
 *   NEGATED + MED/LOW     -> KEEP    A hedge on a negation is exactly when a
 *                                    wrong filter is most likely.
 *   HISTORY + HIGH + excludes  -> FILTER  "既往胃溃疡病史" and the rule's intent
 *                                    says past history is not what it watches.
 *   HISTORY + HIGH + includes  -> KEEP    The doctor's own intent welcomes
 *                                    history, so it stays.
 *   HISTORY + MED/LOW     -> KEEP    Same hedge rule as NEGATED.
 *
 * Everything not listed, and every failure, keeps the hit. There is no default
 * toward filtering anywhere in this file.
 */

/**
 * Is the verdict internally coherent?
 *
 * `matched` and `semanticStatus` are two answers to the same question - "does
 * this context express what the rule watches for" - asked in different
 * vocabularies. NEGATED and HISTORY both mean no; PRESENT and SUSPECTED both
 * mean yes; UNCERTAIN means the model declined to say.
 *
 * A verdict that contradicts itself (NEGATED with matched=true) is not a
 * judgement we can act on: one of the two fields is wrong and we cannot tell
 * which. Treating it as MALFORMED and keeping the hit is the fail-open
 * answer. Note the asymmetry that makes this safety-critical - an incoherent
 * verdict can only ever be on a branch that keeps, because both NEGATED and
 * HISTORY require matched=false before they may filter.
 */
export function isCoherent(verdict: ValidateMatchVerdict): boolean {
  if (verdict.semanticStatus === 'NEGATED' || verdict.semanticStatus === 'HISTORY') {
    return verdict.matched === false;
  }
  if (verdict.semanticStatus === 'PRESENT' || verdict.semanticStatus === 'SUSPECTED') {
    return verdict.matched === true;
  }
  // UNCERTAIN carries no claim either way.
  return true;
}

/** True for the only two confidence levels that may ever authorize a filter. */
export function isHighConfidence(confidence: SemanticConfidence): boolean {
  return confidence === 'HIGH';
}

/**
 * Decide whether one validated verdict removes its keyword hit.
 *
 * @param verdict The validated, evidence-verified verdict.
 * @returns `filtered: true` only for NEGATED+HIGH or
 *          HISTORY+HIGH-with-intent-excluding-history, with a coherent
 *          `matched` flag. Every other input returns `filtered: false`.
 */
export function decideDisposition(verdict: ValidateMatchVerdict): SemanticDisposition {
  if (!isCoherent(verdict)) {
    return { filtered: false, reason: 'MALFORMED_VERDICT_KEEP' };
  }

  switch (verdict.semanticStatus) {
    case 'PRESENT':
      return { filtered: false, reason: 'PRESENT_KEEP' };

    case 'SUSPECTED':
      return { filtered: false, reason: 'SUSPECTED_KEEP' };

    case 'UNCERTAIN':
      return { filtered: false, reason: 'UNCERTAIN_KEEP' };

    case 'NEGATED':
      if (!isHighConfidence(verdict.confidence)) {
        return { filtered: false, reason: 'NEGATED_NOT_HIGH_KEEP' };
      }
      return { filtered: true, reason: 'NEGATED_HIGH_FILTER' };

    case 'HISTORY':
      if (!isHighConfidence(verdict.confidence)) {
        return { filtered: false, reason: 'HISTORY_NOT_HIGH_KEEP' };
      }
      // The model read the doctor's intent; the code applies it. A history
      // mention is only removable when the intent itself says history is not
      // what it is watching for - a rule that does not mention history keeps
      // it, because silence in the intent is not permission to drop hits.
      if (!verdict.intentExcludesHistory) {
        return { filtered: false, reason: 'HISTORY_INTENT_INCLUDES_KEEP' };
      }
      return { filtered: true, reason: 'HISTORY_HIGH_FILTER' };
  }
}

/**
 * The fail-open decision used whenever no verdict can be trusted: every error
 * path, and the evidence-verification failure above them.
 *
 * Takes the reason rather than computing one so the caller - which knows
 * WHICH failure happened - names it. There is deliberately no default: a
 * caller must state its failure, so a new failure mode cannot quietly reuse
 * another one's reason.
 */
export function keepOpen(reason: SemanticDecisionReason): SemanticDisposition {
  return { filtered: false, reason };
}
