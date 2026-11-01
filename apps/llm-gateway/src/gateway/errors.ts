export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Request rate limit exceeded');
    this.name = 'RateLimitedError';
  }
}

export class QuotaExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly used: number,
  ) {
    super('Daily token quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

export class BudgetExceededError extends Error {
  constructor(
    readonly budgetMicroUsd: number,
    readonly spentMicroUsd: number,
  ) {
    super('Daily cost budget exceeded');
    this.name = 'BudgetExceededError';
  }
}
