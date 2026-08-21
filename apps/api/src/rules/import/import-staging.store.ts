import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RawImportRow } from './csv-parser';

interface StagedBatch {
  rows: RawImportRow[];
  createdAt: number;
}

const TTL_MS = 15 * 60 * 1000; // 15 minutes - long enough for a human to review + confirm.

/**
 * Holds validated-but-not-yet-written import batches between the
 * validate and confirm steps, keyed by an opaque token.
 *
 * In-memory and single-process by design: apps/api runs as a single
 * instance for this issue's scope (no horizontal scaling / sticky
 * session concern documented yet), and a validated import batch is
 * inherently short-lived, re-derivable data (the user can just re-upload
 * and re-validate if it's lost to a restart or TTL expiry). If apps/api
 * is later scaled horizontally, this should move to Redis/DB - flagged
 * here rather than silently left as a scaling trap.
 */
@Injectable()
export class ImportStagingStore {
  private readonly batches = new Map<string, StagedBatch>();

  put(rows: RawImportRow[]): string {
    this.evictExpired();
    const token = randomUUID();
    this.batches.set(token, { rows, createdAt: Date.now() });
    return token;
  }

  /** Consumes (removes) the batch so the same token cannot be confirmed twice. */
  take(token: string): RawImportRow[] | undefined {
    this.evictExpired();
    const batch = this.batches.get(token);
    if (!batch) return undefined;
    this.batches.delete(token);
    return batch.rows;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [token, batch] of this.batches) {
      if (now - batch.createdAt > TTL_MS) {
        this.batches.delete(token);
      }
    }
  }
}
