import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Response } from 'express';
import type { CreateWallet } from '../../application/create-wallet';
import { NotFoundError } from '../../application/errors';
import { READ_MODEL, type ReadModel } from '../../application/ports';
import type { ReconcileWallet } from '../../application/reconcile-wallet';
import type { SubmitWagerResult, SubmitWagerTransaction } from '../../application/submit-wager-transaction';
import { ValidationError } from '../../domain/errors';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import { type WagerTransaction, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import type { AppConfig } from '../../infrastructure/config/env';
import { enrichContext, currentContext } from '../../infrastructure/observability/context';
import { logger } from '../../infrastructure/observability/logger';
import type { PrometheusMetrics } from '../../infrastructure/observability/metrics';
import { decodeCursor } from '../../infrastructure/persistence/mikro-orm-read-model';
import { createWalletSchema, parseOrThrow, toCommand, wagerPayloadSchema } from '../contracts';
import { type AuthenticatedRequest, Public, RequireAnyRole, assertActsAsProvider } from './auth.guard';
import {
  APP_CONFIG,
  CREATE_WALLET,
  HEALTH_CHECKS,
  type HealthChecks,
  PROMETHEUS,
  RECONCILE_WALLET,
  SUBMIT_WAGER,
} from './tokens';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, name: string): string {
  if (!UUID.test(value)) {
    throw new ValidationError(`${name} must be a UUID`);
  }
  return value;
}

export function walletView(w: Wallet) {
  return { id: w.id, playerId: w.playerId, balance: w.balance.toJSON(), version: w.version };
}

export function transactionView(t: WagerTransaction) {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    idempotencyKey: t.idempotencyKey,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    status: t.status,
    failureCode: t.failureCode,
    balance: t.resultingBalance?.toJSON(),
    referenceAttempts: t.referenceAttempts,
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}

function ledgerView(e: WalletLedgerEntry) {
  return {
    id: e.id,
    transactionId: e.transactionId,
    direction: e.direction,
    money: e.money.toJSON(),
    balanceBefore: e.balanceBefore.toJSON(),
    balanceAfter: e.balanceAfter.toJSON(),
    walletVersion: e.walletVersion,
    createdAt: e.createdAt.toISOString(),
  };
}

/** Status HTTP por resultado (ARCHITECTURE §8): o provedor decide sem ler mensagens. */
export function statusFor(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? 200 : 201;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return 422;
  }
}

@Controller('wallets')
@RequireAnyRole('wallet-admin')
export class WalletsController {
  constructor(
    @Inject(CREATE_WALLET) private readonly createWallet: CreateWallet,
    @Inject(RECONCILE_WALLET) private readonly reconcile: ReconcileWallet,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = parseOrThrow(createWalletSchema, body, 'wallet');
    const wallet = await this.createWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      correlationId: currentContext().correlationId ?? '',
    });
    enrichContext({ walletId: wallet.id });
    logger.info('wallet created');
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.readModel.findWallet(requireUuid(walletId, 'walletId'));
    if (!wallet) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    }
    return walletView(wallet);
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    requireUuid(walletId, 'walletId');
    const limit = limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (limitRaw !== undefined && !/^\d+$/.test(limitRaw))) {
      throw new ValidationError('limit must be an integer between 1 and 200');
    }
    const before = cursor === undefined ? undefined : decodeCursor(cursor);
    if (cursor !== undefined && before === undefined) {
      throw new ValidationError('Invalid cursor');
    }
    if (!(await this.readModel.findWallet(walletId))) {
      throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
    }
    const page = await this.readModel.ledgerPage(walletId, limit, before);
    return { items: page.entries.map(ledgerView), nextCursor: page.nextCursor ?? null };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string) {
    enrichContext({ walletId });
    return this.reconcile.execute(requireUuid(walletId, 'walletId'));
  }
}

@Controller()
export class WageringController {
  constructor(
    @Inject(SUBMIT_WAGER) private readonly submit: SubmitWagerTransaction,
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('wagering/transactions')
  @RequireAnyRole('provider')
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === '' || idempotencyKey.length > 255) {
      throw new ValidationError('Idempotency-Key header is required (max 255 chars)');
    }
    const payload = parseOrThrow(wagerPayloadSchema, body, 'wager transaction');
    enrichContext({ walletId: payload.walletId, providerId: payload.providerId });
    assertActsAsProvider(req.principal, payload.providerId, this.config.auth.adminRole, false);

    const result = await this.submit.execute({
      command: toCommand(payload, idempotencyKey),
      source: { type: 'http' },
      correlationId: currentContext().correlationId ?? '',
    });
    enrichContext({ transactionId: result.transactionId });
    logger.info({ status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay }, 'wager submitted');
    res.status(statusFor(result));
    return {
      transactionId: result.transactionId,
      status: result.status,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
      balance: result.balance ?? null,
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  @RequireAnyRole('provider', 'wallet-admin')
  async getTransaction(@Param('transactionId') transactionId: string, @Req() req: AuthenticatedRequest) {
    const tx = await this.readModel.findTransaction(requireUuid(transactionId, 'transactionId'));
    if (!tx) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${transactionId} not found`);
    }
    assertActsAsProvider(req.principal, tx.providerId, this.config.auth.adminRole, true);
    return transactionView(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @RequireAnyRole('provider', 'wallet-admin')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    assertActsAsProvider(req.principal, providerId, this.config.auth.adminRole, true);
    const tx = await this.readModel.findTransactionByExternalId(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundError('TRANSACTION_NOT_FOUND', `Transaction ${providerId}/${externalTransactionId} not found`);
    }
    return transactionView(tx);
  }
}

@Controller()
@Public()
export class OperationsController {
  constructor(
    @Inject(HEALTH_CHECKS) private readonly health: HealthChecks,
    @Inject(PROMETHEUS) private readonly metrics: PrometheusMetrics,
  ) {}

  /** Liveness: o processo responde. Não depende de nada externo (não deve reiniciar o pod por causa do banco). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis. */
  @Get('health/ready')
  async ready() {
    const [db, queue] = await Promise.allSettled([this.health.database(), this.health.queue()]);
    const checks = {
      postgres: db.status === 'fulfilled' ? 'up' : 'down',
      sqs: queue.status === 'fulfilled' ? 'up' : 'down',
    };
    if (db.status === 'rejected' || queue.status === 'rejected') {
      throw new ServiceUnavailableException({ code: 'NOT_READY', status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async prometheus() {
    return this.metrics.registry.metrics();
  }
}
