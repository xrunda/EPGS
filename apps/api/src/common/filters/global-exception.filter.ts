import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiErrorBody } from '@epgs/shared-types';
import { CORRELATION_ID_HEADER } from '../middleware/correlation-id.middleware';
import { AppLoggerService } from '../logger/app-logger.service';

/**
 * Converts any thrown error into the unified error response shape:
 * { error: { code, message, correlationId } }
 *
 * Never echoes back raw error messages for non-HttpExceptions (5xx) to
 * avoid leaking internals/secrets - only a generic message is returned,
 * while the real error is logged server-side with the correlation id.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new AppLoggerService();

  constructor() {
    this.logger.setContext('GlobalExceptionFilter');
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId =
      request.correlationId ?? request.header(CORRELATION_ID_HEADER) ?? 'unknown';

    const { status, code, message, details } = this.resolve(exception);

    this.logger.error(
      `${request.method} ${request.url} -> ${status} ${code}: ${message}`,
      exception instanceof Error ? exception.stack : undefined,
      correlationId,
    );

    const body: ApiErrorBody = {
      error: {
        code,
        message,
        correlationId,
        ...(details ? { details } : {}),
      },
    };

    response.status(status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const responseObj =
        typeof response === 'object' && response !== null
          ? (response as {
              message?: string | string[];
              code?: string;
              details?: Record<string, unknown>;
            })
          : undefined;
      const message =
        typeof response === 'string' ? response : (responseObj?.message ?? exception.message);

      return {
        status,
        // A thrown HttpException may carry an explicit machine-readable
        // `code` in its response body (e.g. 'RULE_CONFLICT' for 409s from
        // the rules module) - prefer that over the generic HTTP status
        // name so domain-specific errors stay distinguishable.
        code: responseObj?.code ?? HttpStatus[status] ?? 'HTTP_ERROR',
        message: Array.isArray(message) ? message.join(', ') : message,
        details: responseObj?.details,
      };
    }

    // Unknown/unhandled error - never leak internals in the response body.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    };
  }
}
