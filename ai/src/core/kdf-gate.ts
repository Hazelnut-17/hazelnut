// The derivation gate: a bounded-concurrency, FIFO, deadline-capped queue in front of a costly KDF.
//
// A memory-hard KDF turns every UNAUTHENTICATED login into a fixed allocation, so N concurrent attempts
// cost N × that whether or not any password is right. A per-identifier login throttle cannot see this — a
// thousand distinct identifiers are a thousand un-throttled derivations — so the bound that matters is on
// derivations IN FLIGHT. It lives here, not in the login recipe, because every door that hashes (confirm
// codes, refresh tokens) amplifies identically.
//
// The limits are CONSTRUCTOR arguments rather than module constants so the behaviour can be driven to its
// boundary deterministically, with resolved promises instead of a wall-clock race.

/** Raised when a caller waited past the gate's deadline. Deliberately NOT a verification failure: a
 *  saturated box must never be reported as a wrong password, to the user or to an attacker probing load. */
export class KdfOverloadedError extends Error {
  constructor(maxInFlight: number, maxWaitMs: number) {
    super(
      `password hashing is saturated (>${maxInFlight} in flight for >${maxWaitMs}ms) — the caller should retry`,
    );
    this.name = "KdfOverloadedError";
  }
}

interface Waiter {
  admit(): void;
  refuse(): void;
}

export class DerivationGate {
  #inFlight = 0;
  readonly #waiters: Waiter[] = [];

  constructor(
    readonly maxInFlight: number,
    readonly maxWaitMs: number,
  ) {}

  /** Derivations currently holding a slot — the resident cost. Read by the gate's own teeth. */
  get inFlight(): number {
    return this.#inFlight;
  }

  /** Callers queued behind a full gate. They hold no memory; only the deadline is armed. */
  get queued(): number {
    return this.#waiters.length;
  }

  /**
   * Run `fn` holding one of `maxInFlight` slots. Admission is FIFO, so a burst cannot starve the attempt
   * that arrived first. A caller queued longer than `maxWaitMs` rejects with `KdfOverloadedError` and is
   * removed from the queue, so a refused waiter can never later consume a slot nobody is waiting on.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#inFlight >= this.maxInFlight) await this.#waitForSlot();
    this.#inFlight++;
    try {
      return await fn();
    } finally {
      this.#inFlight--;
      this.#waiters.shift()?.admit();
    }
  }

  #waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        admit: () => {
          clearTimeout(timer);
          resolve();
        },
        refuse: () => {
          const i = this.#waiters.indexOf(w);
          if (i >= 0) this.#waiters.splice(i, 1);
          reject(new KdfOverloadedError(this.maxInFlight, this.maxWaitMs));
        },
      };
      const timer = setTimeout(() => w.refuse(), this.maxWaitMs);
      this.#waiters.push(w);
    });
  }
}
