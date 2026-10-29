// Retry facts belong to the enclosing operation, outside any rolled-back transaction.
// This leaf carries only bounded numeric facts: no database, log sink or driver error.
import { AsyncLocalStorage } from "node:async_hooks";

interface RetryFacts {
  retries: number;
  exhausted: number;
  span?: object;
}

const observations = new AsyncLocalStorage<RetryFacts>();

/** Every operation owns a fresh observation; nested/concurrent operations do not borrow it. */
export function observeTransactionRetries<T>(
  work: () => Promise<T>,
): Promise<T> {
  return observations.run({ retries: 0, exhausted: 0 }, work);
}

/** Only the span returned to this operation's wrapper may receive its retry facts. */
export function ownTransactionRetrySpan(span: object): void {
  const facts = observations.getStore();
  if (facts) facts.span = span;
}

export function transactionRetrySpanAttrs(
  span: object,
  attrs: Readonly<Record<string, unknown>>,
): Record<string, number> {
  return observations.getStore()?.span === span
    ? recordedTransactionRetries(attrs)
    : {};
}

/** Count an actual thunk re-entry, or the final accepted transient abort at the cap. */
export function noteTransactionRetry(exhausted: boolean): void {
  const facts = observations.getStore();
  if (!facts) return;
  if (exhausted) facts.exhausted++;
  else facts.retries++;
}

/** Reserved framework facts replace authored decorations bearing the same names. */
export function transactionRetryAttrs<T>(
  attrs: Readonly<Record<string, T>>,
): Record<string, T | number> {
  const out = Object.fromEntries(
    Object.entries(attrs).filter(([key]) =>
      key !== "db.retry.count" && key !== "db.retry.exhausted"
    ),
  );
  const facts = observations.getStore();
  if (!facts || (facts.retries === 0 && facts.exhausted === 0)) return out;
  return {
    ...out,
    "db.retry.count": facts.retries,
    "db.retry.exhausted": facts.exhausted,
  };
}

/** Only the closed numeric fields may reach span/metric metadata. */
export function recordedTransactionRetries(
  attrs: Readonly<Record<string, unknown>> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["db.retry.count", "db.retry.exhausted"]) {
    const value = attrs?.[key];
    if (
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ) {
      out[key] = value;
    }
  }
  return out;
}
