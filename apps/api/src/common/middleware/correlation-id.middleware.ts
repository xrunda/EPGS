// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient .d.ts augmentation, not a module import
/// <reference path="../../types/express.d.ts" />
import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Propagates an existing x-correlation-id header, or generates a new one,
 * attaches it to the request object (for logging) and echoes it back on
 * the response so callers can correlate requests across services.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_ID_HEADER);
    const correlationId = incoming && incoming.trim().length > 0 ? incoming : randomUUID();

    req.correlationId = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
