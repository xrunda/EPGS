import { Injectable, LoggerService, Scope } from '@nestjs/common';

type LogLevel = 'fatal' | 'error' | 'warn' | 'log' | 'debug' | 'verbose';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  log: 3,
  debug: 4,
  verbose: 5,
};

/**
 * Structured JSON logger with consistent fields: timestamp, level,
 * correlationId, message. Never log secrets - callers must not pass
 * env values / config objects as log messages or metadata.
 *
 * This is intentionally dependency-light (no pino) to keep issue #1's
 * footprint small; swapping the transport later is a localized change
 * since all app code goes through this service / the Nest Logger token.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class AppLoggerService implements LoggerService {
  private context?: string;
  private readonly minLevel: LogLevel;

  constructor() {
    const configured = (process.env.LOG_LEVEL as LogLevel) ?? 'log';
    this.minLevel = LEVEL_WEIGHT[configured] !== undefined ? configured : 'log';
  }

  setContext(context: string): void {
    this.context = context;
  }

  log(message: unknown, correlationId?: string): void {
    this.write('log', message, correlationId);
  }

  error(message: unknown, trace?: string, correlationId?: string): void {
    this.write('error', message, correlationId, trace);
  }

  warn(message: unknown, correlationId?: string): void {
    this.write('warn', message, correlationId);
  }

  debug(message: unknown, correlationId?: string): void {
    this.write('debug', message, correlationId);
  }

  verbose(message: unknown, correlationId?: string): void {
    this.write('verbose', message, correlationId);
  }

  private write(level: LogLevel, message: unknown, correlationId?: string, trace?: string): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.minLevel]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      correlationId,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      ...(trace ? { trace } : {}),
    };

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }
}
