export const APP_CONFIG = Symbol('AppConfig');
export const SUBMIT_WAGER = Symbol('SubmitWagerTransaction');
export const CREATE_WALLET = Symbol('CreateWallet');
export const RECONCILE_WALLET = Symbol('ReconcileWallet');
export const HEALTH_CHECKS = Symbol('HealthChecks');
export const PROMETHEUS = Symbol('PrometheusMetrics');

export interface HealthChecks {
  database(): Promise<void>;
  queue(): Promise<void>;
}
