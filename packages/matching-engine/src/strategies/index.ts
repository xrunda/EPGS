import type { RuleSnapshot } from '../types';
import type { MatchStrategy } from './types';
import { ContainsStrategy } from './contains-strategy';
import { ExactStrategy } from './exact-strategy';
import { RegexStrategy } from './regex-strategy';

export type { MatchStrategy, StrategyHit } from './types';
export { ContainsStrategy } from './contains-strategy';
export { ExactStrategy } from './exact-strategy';
export { RegexStrategy } from './regex-strategy';

/**
 * Registry mapping MatchMode -> strategy implementation. Adding a new
 * MatchMode (e.g. a future negation-aware mode) means adding one entry
 * here plus a new MatchStrategy implementation - matcher.ts never needs
 * to change.
 */
const STRATEGIES: Record<RuleSnapshot['matchMode'], MatchStrategy> = {
  CONTAINS: new ContainsStrategy(),
  EXACT: new ExactStrategy(),
  REGEX: new RegexStrategy(),
};

export function getStrategy(mode: RuleSnapshot['matchMode']): MatchStrategy {
  const strategy = STRATEGIES[mode];
  if (!strategy) {
    throw new Error(`matching-engine: no MatchStrategy registered for mode "${mode}"`);
  }
  return strategy;
}
