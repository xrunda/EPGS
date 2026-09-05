import type { Request } from 'express';
import { MonitorLevel } from '@prisma/client';

/**
 * The alert_link row resolved by AlertLinkGuard for the current request
 * (issue #72). Carries the frozen record-id snapshot every read on
 * /api/alert-links is narrowed to. Never contains the token (only its hash
 * was ever stored) and never patient data.
 */
export interface ResolvedAlertLink {
  id: string;
  level: MonitorLevel;
  windowDate: string;
  recordIds: string[];
  createdAt: Date;
  expiresAt: Date;
}

export type AlertLinkRequest = Request & { alertLink?: ResolvedAlertLink };
