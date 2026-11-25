import { MatchField, MonitorLevel } from '@prisma/client';

/**
 * Issue #159: derive the `部位+病名` cell for the CSV export.
 *
 * This is a DETERMINISTIC, side-effect-free text function - no Prisma, no Nest,
 * no model. The export is a bulk read; calling a model once per row would be
 * both slow and non-reproducible, and this column is a convenience for reading
 * the file, not a clinical judgement.
 *
 * The anchor is the effective hit that put the record at its HIGHEST level
 * (RED first); its keyword and position are what the record is "about". The
 * disease name is taken from the diagnosis first (that is where the report
 * states it), then from the anchor's own field. The site is taken from the
 * text around the anchor, then the diagnosis/report body, and a generic organ
 * is refined to a sub-site when the report names one (胃 -> 胃窦, 食管 ->
 * 食管中段).
 *
 * Every failure degrades to a readable label (`部位未明` / `病名未明`), never to
 * a guess that pretends to be certain. A record with no matches at all (e.g.
 * an UNCLASSIFIED row exported by an operator who ticked that level) gets an
 * empty cell.
 */

/** The subset of a match row this function needs. Offsets are nullable: old
 *  rows and fixtures may not carry them, and a missing offset just means "search
 *  the whole field" rather than "no site". */
export interface SiteDiseaseMatch {
  keyword: string;
  level?: MonitorLevel | null;
  matchedField?: MatchField | null;
  matchStart?: number | null;
  matchEnd?: number | null;
}

export interface SiteDiseaseInput {
  reportContent: string | null;
  diagnosis: string | null;
  matches: readonly SiteDiseaseMatch[];
}

/**
 * Anatomical sites, longest first. Ordered by the sort rather than by hand so
 * adding "胃窦小弯" later cannot shadow "胃窦" by accident.
 */
const SITE_TERMS: readonly string[] = [
  '食管上段',
  '食管中段',
  '食管下段',
  '食管入口',
  '十二指肠球部',
  '十二指肠',
  '回盲部',
  '回盲瓣',
  '回肠末端',
  '升结肠',
  '结肠肝曲',
  '横结肠',
  '结肠脾曲',
  '降结肠',
  '乙状结肠',
  '肝曲',
  '脾曲',
  '球部',
  '空肠',
  '回肠',
  '结肠',
  '直肠',
  '肛管',
  '肛门',
  '胃底',
  '胃体',
  '胃角',
  '胃窦',
  '幽门',
  '贲门',
  '食管',
  '食道',
  '小肠',
  '胃',
].sort((a, b) => b.length - a.length);

/**
 * Tumour / pre-cancer disease names, longest first. `癌` is deliberately last
 * so `腺癌`, `鳞癌`, `高级别上皮内瘤变` win before the one-character fallback.
 */
const DISEASE_TERMS: readonly string[] = [
  '高级别上皮内瘤变',
  '低级别上皮内瘤变',
  '上皮内瘤变',
  '神经内分泌肿瘤',
  '神经内分泌瘤',
  '神经内分泌癌',
  '印戒细胞癌',
  '黏液腺癌',
  '粘液腺癌',
  '腺鳞癌',
  '黏膜下肿瘤',
  '黏膜下肿物',
  '转移瘤',
  '转移癌',
  '恶性肿瘤',
  '原位癌',
  '浸润癌',
  '早癌',
  '间质瘤',
  '淋巴瘤',
  '息肉病',
  '类癌',
  '腺癌',
  '鳞癌',
  '腺瘤',
  '息肉',
  '肿瘤',
  '肿物',
  '占位',
  '新生物',
  '癌变',
  '癌',
  'Barrett',
  '巴雷特',
  'GIST',
  'SMT',
  'NEN',
].sort((a, b) => b.length - a.length);

/** Organs that a report can refine to a sub-site (`胃` -> `胃窦`). */
const GENERIC_SITES = new Set([
  '食管',
  '食道',
  '胃',
  '结肠',
  '直肠',
  '十二指肠',
  '小肠',
  '回肠',
  '空肠',
]);

const LEVEL_RANK: Record<string, number> = {
  RED: 0,
  YELLOW: 1,
  GREEN: 2,
  UNCLASSIFIED: 3,
};

interface TermHit {
  term: string;
  index: number;
}

/** Every occurrence of every term, case-insensitively. Overlaps are kept on
 *  purpose: `腺癌` and `癌` both hit the same diagnosis, and the longer term is
 *  what the caller wants. */
function findTermHits(text: string, terms: readonly string[]): TermHit[] {
  const haystack = text.toLowerCase();
  const hits: TermHit[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    let from = 0;
    for (;;) {
      const index = haystack.indexOf(needle, from);
      if (index === -1) break;
      hits.push({ term, index });
      from = index + 1;
    }
  }
  return hits;
}

function firstSite(text: string | null): string | null {
  if (!text) return null;
  const hits = findTermHits(text, SITE_TERMS);
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.index - b.index || b.term.length - a.term.length);
  return hits[0]!.term;
}

/** The site closest to the anchor occurrence. Distance 0 means the term touches
 *  the keyword; ties prefer the longer term (胃窦 over 胃). */
function siteNear(text: string | null, start: number, end: number): string | null {
  if (!text) return null;
  const hits = findTermHits(text, SITE_TERMS);
  if (hits.length === 0) return null;
  const scored = hits.map((hit) => {
    const hitEnd = hit.index + hit.term.length;
    const distance = hitEnd <= start ? start - hitEnd : hit.index >= end ? hit.index - end : 0;
    return { ...hit, distance };
  });
  scored.sort(
    (a, b) => a.distance - b.distance || b.term.length - a.term.length || a.index - b.index,
  );
  return scored[0]!.term;
}

/** A generic organ gets the longest sub-site the same texts name. This is what
 *  turns the diagnosis "胃癌" plus the body "胃窦见..." into 胃窦 rather than a
 *  bare 胃. It never crosses to a different organ: the longer term must contain
 *  the generic one. */
function refineSite(site: string, texts: readonly (string | null)[]): string {
  if (!GENERIC_SITES.has(site)) return site;
  const hits = texts
    .filter((text): text is string => Boolean(text))
    .flatMap((text) => findTermHits(text, SITE_TERMS))
    .filter((hit) => hit.term.length > site.length && hit.term.includes(site));
  if (hits.length === 0) return site;
  hits.sort((a, b) => b.term.length - a.term.length || a.index - b.index);
  return hits[0]!.term;
}

function pickAnchor(matches: readonly SiteDiseaseMatch[]): SiteDiseaseMatch | null {
  let best: SiteDiseaseMatch | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const match of matches) {
    const rank = LEVEL_RANK[match.level ?? 'UNCLASSIFIED'] ?? 3;
    if (rank < bestRank) {
      best = match;
      bestRank = rank;
    }
  }
  return best;
}

function textsForAnchor(
  anchor: SiteDiseaseMatch,
  reportContent: string | null,
  diagnosis: string | null,
): string[] {
  switch (anchor.matchedField) {
    case 'FINDINGS':
      return reportContent ? [reportContent] : [];
    case 'IMPRESSION':
      return diagnosis ? [diagnosis] : [];
    case 'REPORT_TEXT':
    case 'OTHER':
    case 'STUDY_DESCRIPTION':
    default:
      // The matcher writes the concrete field, so this branch is for fixtures
      // and legacy rows. Both texts are fair game.
      return [reportContent, diagnosis].filter((text): text is string => Boolean(text));
  }
}

/** The disease name from a text, preferring a term related to the anchor
 *  keyword (contains it, or is contained by it) before falling back to the
 *  longest term. */
function pickDisease(text: string | null, anchorKeyword: string): string | null {
  if (!text) return null;
  const hits = findTermHits(text, DISEASE_TERMS);
  if (hits.length === 0) return null;
  const related = (hit: TermHit): boolean =>
    Boolean(anchorKeyword) &&
    (hit.term.includes(anchorKeyword) || anchorKeyword.includes(hit.term));
  const pool = hits.filter(related);
  const candidates = pool.length > 0 ? pool : hits;
  candidates.sort((a, b) => b.term.length - a.term.length || a.index - b.index);
  return candidates[0]!.term;
}

/**
 * Returns `部位+病名` for one export row, or an empty string when the record
 * has no effective match at all.
 */
export function deriveSiteDisease(input: SiteDiseaseInput): string {
  const anchor = pickAnchor(input.matches);
  if (!anchor) return '';

  const anchorTexts = textsForAnchor(anchor, input.reportContent, input.diagnosis);

  // --- Site -------------------------------------------------------------
  let site: string | null = null;
  if (
    anchor.matchStart !== null &&
    anchor.matchStart !== undefined &&
    anchor.matchEnd !== null &&
    anchor.matchEnd !== undefined
  ) {
    for (const text of anchorTexts) {
      site = siteNear(text, anchor.matchStart, anchor.matchEnd);
      if (site) break;
    }
  }
  if (!site) {
    for (const text of anchorTexts) {
      site = firstSite(text);
      if (site) break;
    }
  }
  if (!site) site = firstSite(input.diagnosis) ?? firstSite(input.reportContent);
  if (site) site = refineSite(site, [input.diagnosis, input.reportContent]);

  // --- Disease ----------------------------------------------------------
  let disease = pickDisease(input.diagnosis, anchor.keyword);
  if (!disease) {
    for (const text of anchorTexts) {
      disease = pickDisease(text, anchor.keyword);
      if (disease) break;
    }
  }
  if (!disease) disease = pickDisease(input.reportContent, anchor.keyword);
  if (!disease) disease = anchor.keyword.trim() || null;

  return `${site ?? '部位未明'}+${disease ?? '病名未明'}`;
}
