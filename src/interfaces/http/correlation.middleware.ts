import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';
import { runWithContext } from '../../infrastructure/observability/context';

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Propaga X-Correlation-Id (ou gera um) para logs, eventos e resposta. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
  res.setHeader('X-Correlation-Id', correlationId);
  runWithContext({ correlationId }, () => next());
}
