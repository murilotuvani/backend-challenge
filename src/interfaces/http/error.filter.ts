import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import {
  ApplicationError,
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  NotFoundError,
  ProviderMismatchError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { CurrencyMismatchError, DomainError, ValidationError } from '../../domain/errors';
import { logger } from '../../infrastructure/observability/logger';
import { currentContext } from '../../infrastructure/observability/context';
import { safeError } from '../../infrastructure/observability/safe-error';

/**
 * Mapeamento único de erros para HTTP (ARCHITECTURE §8). Todo corpo de erro tem o mesmo formato:
 * { code, message, details?, correlationId } — o provedor decide pelo status e pelo `code`, nunca pela mensagem.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body, headers } = this.map(exception);
    const correlationId = currentContext().correlationId;
    if (status >= 500) {
      logger.error({ err: safeError(exception), status }, 'request failed');
    }
    for (const [k, v] of Object.entries(headers)) {
      response.setHeader(k, v);
    }
    response.status(status).json({ ...body, correlationId });
  }

  private map(e: unknown): { status: number; body: Record<string, unknown>; headers: Record<string, string> } {
    const out = (status: number, code: string, message: string, extra: Record<string, unknown> = {}, headers = {}) => ({
      status,
      body: { code, message, ...extra },
      headers,
    });
    if (e instanceof ValidationError) {
      return out(400, e.code, e.message, e.details.length ? { details: e.details } : {});
    }
    if (e instanceof CurrencyMismatchError) {
      return out(400, 'VALIDATION_ERROR', e.message);
    }
    if (e instanceof IdempotencyConflictError) {
      return out(409, e.code, e.message, { transactionId: e.existingTransactionId });
    }
    if (e instanceof ExternalTransactionConflictError || e instanceof WalletAlreadyExistsError) {
      return out(409, e.code, e.message);
    }
    if (e instanceof NotFoundError) {
      return out(404, e.code, e.message);
    }
    if (e instanceof ProviderMismatchError) {
      return out(403, e.code, e.message);
    }
    if (e instanceof TransientInfrastructureError) {
      return out(503, e.code, 'Temporary failure, nothing was committed; retry with the same Idempotency-Key', {}, {
        'Retry-After': '1',
      });
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const res = e.getResponse();
      if (typeof res === 'object' && res && 'code' in res) {
        return { status, body: res as Record<string, unknown>, headers: {} };
      }
      const code = status === 400 ? 'VALIDATION_ERROR' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
      return out(status, code, e.message);
    }
    if (e instanceof SyntaxError) {
      return out(400, 'VALIDATION_ERROR', 'Malformed JSON body');
    }
    if (e instanceof DomainError || e instanceof ApplicationError) {
      return out(500, e.code, 'Internal error');
    }
    return out(500, 'INTERNAL_ERROR', 'Internal error');
  }
}
