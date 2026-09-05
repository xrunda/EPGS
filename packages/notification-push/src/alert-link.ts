import { createHash, randomBytes } from 'crypto';
import { NotificationSummaryProvider } from './summary';
import { formatKeywordHits } from './render';
import { PushLevel } from './types';

/**
 * Per-level "点击查看患者列表" alert links appended to a push run (issue #72).
 *
 * After the aggregate TEXT/NEWS template message, a run may send up to three
 * extra single-article WeCom `news` messages - one per RED / YELLOW / GREEN
 * level that has at least one record in the summary window (issue #76: one
 * message per card, because personal WeChat's 企业会话 renders a single-article
 * news but not a multi-article one). Each card links to the web app's
 * `/alert` H5 page with an opaque token; the api resolves the token to a
 * frozen snapshot of that level's monitor_record ids as of this run
 * (membership never drifts afterwards).
 *
 * SECURITY MODEL (docs/auth.md "预警链接受限凭证"):
 *   - The token is 32 random bytes (base64url). It is NOT a JWT and carries
 *     no claims; the alert_link row is the sole source of truth. Only its
 *     SHA-256 hex hash is persisted, so a DB read cannot recover a live link.
 *   - The link is the credential: the H5 page presents it as a Bearer token
 *     and AlertLinkGuard narrows every read to the snapshot's record ids.
 *     No epgs_session cookie is ever issued from a link.
 *   - Expiry = createdAt + ttlHours (24h by default, user decision). Links
 *     stay reopenable within the window - no single-use, no open cap.
 *
 * Framework/DB-agnostic like the rest of this package: the store seam is
 * implemented by each app over its own Prisma client, and `randomBytes` is
 * injectable for deterministic tests.
 */

/** The three levels that get a card. UNCLASSIFIED is deliberately excluded. */
export const ALERT_LINK_LEVELS: readonly AlertLinkLevel[] = ['RED', 'YELLOW', 'GREEN'];

export type AlertLinkLevel = Exclude<PushLevel, 'UNCLASSIFIED'>;

export const ALERT_LINK_LEVEL_LABELS: Record<AlertLinkLevel, string> = {
  RED: '红色',
  YELLOW: '黄色',
  GREEN: '绿色',
};

/** URL path (relative to ALERT_LINK_BASE_URL) of the web app's H5 entry. */
export const ALERT_LINK_PATH = '/alert';

/** Query parameter carrying the token on the H5 entry URL. */
export const ALERT_LINK_TOKEN_PARAM = 't';

/**
 * Path (relative to ALERT_LINK_BASE_URL) of the card cover image, served
 * from apps/web/public so it exists at the same origin as /alert in both the
 * Vite dev server and the built dist. The viewer's client fetches it, so it
 * must be reachable wherever /alert is. The file is a 1068x455 banner (the
 * WeCom large-image size) with the hospital emblem inside the central
 * 455x455 square: WeCom shows the wide banner, personal WeChat's 企业会话
 * shows a square centre crop - both keep the emblem whole.
 */
export const ALERT_LINK_COVER_PATH = '/alert-cover.jpg';

/** Token = 32 random bytes → 43-char base64url; the guard validates this shape. */
export const ALERT_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

/** WeCom news article limits (bytes, per the webhook docs); we stay well under. */
const MAX_TITLE_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 160;

/** One article card for the WeCom news message. */
export interface AlertLinkCard {
  level: AlertLinkLevel;
  /** Number of records frozen into this link's snapshot. */
  count: number;
  title: string;
  description: string;
  url: string;
  /** Cover image (WeCom `picurl`), `${baseUrl}${ALERT_LINK_COVER_PATH}`. */
  coverUrl: string;
}

export interface CreateAlertLinkInput {
  tokenHash: string;
  level: AlertLinkLevel;
  windowDate: string;
  /** The push_log this link was issued for; null for runs without a log. */
  pushLogId: string | null;
  recordIds: string[];
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Data-access seam for alert links. Implemented by
 * apps/api/src/notifications/notification-push.adapters.ts and
 * apps/worker/src/notification-push/worker-alert-link.store.ts.
 */
export interface AlertLinkStore {
  /**
   * monitor_record ids per level for the summary window, using the SAME
   * where-clause as the summary counts (examTime inside the Shanghai day,
   * department in `scope` when given) so card counts equal the summary.
   */
  listRecordIdsByLevel(input: {
    windowDate: string;
    scope?: string[];
  }): Promise<Partial<Record<AlertLinkLevel, string[]>>>;
  /** Persists one link row (token hash only, never the token). */
  createAlertLink(input: CreateAlertLinkInput): Promise<{ id: string }>;
}

export interface AlertLinkIssuerDeps {
  store: AlertLinkStore;
  summary: NotificationSummaryProvider;
  /**
   * Absolute origin (+ optional path prefix) the H5 page is reachable at
   * from WeCom clients, e.g. `http://10.0.0.5:5173`. `null` DISABLES the
   * feature: issue() returns no cards and writes nothing.
   */
  baseUrl: string | null;
  /** Link lifetime in hours (ALERT_LINK_TTL_HOURS, default 24). */
  ttlHours: number;
  /** Provides HOSPITAL_NAME for the card description. */
  hospitalNameProvider: () => string;
  /** Injectable for deterministic tests; defaults to crypto.randomBytes. */
  tokenGenerator?: () => string;
  /** Injectable clock; defaults to real now. */
  nowProvider?: () => Date;
}

export interface IssueAlertLinksInput {
  windowDate: string;
  pushLogId: string | null;
  /** Department scope (empty/undefined = global), mirrors the summary contract. */
  scope?: string[];
  /** Anchors createdAt/expiresAt; defaults to nowProvider(). */
  now?: Date;
}

/** Generates a fresh opaque token (32 random bytes, base64url). */
export function generateAlertLinkToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 hex of a token - the only form ever persisted. */
export function hashAlertLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Builds the H5 entry URL for a token. Trailing slashes on baseUrl are tolerated. */
export function buildAlertLinkUrl(baseUrl: string, token: string): string {
  const origin = baseUrl.replace(/\/+$/, '');
  return `${origin}${ALERT_LINK_PATH}?${ALERT_LINK_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

export class AlertLinkIssuer {
  private readonly tokenGenerator: () => string;
  private readonly nowProvider: () => Date;

  constructor(private readonly deps: AlertLinkIssuerDeps) {
    this.tokenGenerator = deps.tokenGenerator ?? generateAlertLinkToken;
    this.nowProvider = deps.nowProvider ?? (() => new Date());
  }

  /** True when ALERT_LINK_BASE_URL is configured (cards will be issued). */
  get enabled(): boolean {
    return this.deps.baseUrl !== null && this.deps.baseUrl.trim() !== '';
  }

  /**
   * Freezes one snapshot + token per level with >= 1 record and returns the
   * cards to append to the run. Levels with 0 records get no card and no row
   * (user decision: skip empty levels). Returns [] when disabled.
   */
  async issue(input: IssueAlertLinksInput): Promise<AlertLinkCard[]> {
    if (!this.enabled) return [];
    const baseUrl = this.deps.baseUrl as string;

    const now = input.now ?? this.nowProvider();
    const expiresAt = new Date(now.getTime() + this.deps.ttlHours * 60 * 60 * 1000);

    const [idsByLevel, summary] = await Promise.all([
      this.deps.store.listRecordIdsByLevel({ windowDate: input.windowDate, scope: input.scope }),
      this.deps.summary.get({ date: input.windowDate, scope: input.scope }),
    ]);
    const hospitalName = this.deps.hospitalNameProvider();

    const cards: AlertLinkCard[] = [];
    for (const level of ALERT_LINK_LEVELS) {
      const recordIds = idsByLevel[level] ?? [];
      if (recordIds.length === 0) continue;

      const token = this.tokenGenerator();
      await this.deps.store.createAlertLink({
        tokenHash: hashAlertLinkToken(token),
        level,
        windowDate: input.windowDate,
        pushLogId: input.pushLogId,
        recordIds,
        createdAt: now,
        expiresAt,
      });

      cards.push({
        level,
        count: recordIds.length,
        title: truncate(
          `${ALERT_LINK_LEVEL_LABELS[level]}关注 ${recordIds.length} 例 · ${input.windowDate}`,
          MAX_TITLE_CHARS,
        ),
        description: truncate(
          buildDescription(
            hospitalName,
            formatKeywordHits(summary.keywordHits, level, 3),
            this.deps.ttlHours,
          ),
          MAX_DESCRIPTION_CHARS,
        ),
        url: buildAlertLinkUrl(baseUrl, token),
        coverUrl: buildAlertCoverUrl(baseUrl),
      });
    }
    return cards;
  }
}

/** Absolute URL of the card cover image on the same origin as /alert. */
export function buildAlertCoverUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${ALERT_LINK_COVER_PATH}`;
}

function buildDescription(hospitalName: string, keywords: string, ttlHours: number): string {
  const keywordPart = keywords === '—' ? '' : `命中：${keywords}｜`;
  return `${hospitalName}｜${keywordPart}点击查看患者列表（脱敏），链接 ${ttlHours} 小时内有效`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
