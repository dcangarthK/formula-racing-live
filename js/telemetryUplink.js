// Browser-side live telemetry transport. Authentication is obtained per race
// from the configured session endpoint and is held in memory only.

const clone = (value) => typeof structuredClone === 'function'
  ? structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');
const TELEMETRY_SCHEMA_VERSION = 'formula-racing-live.telemetry.v1';

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
}

export class TelemetryUplink {
  constructor(options = {}) {
    this.baseUrl = typeof options.baseUrl === 'string' ? trimTrailingSlash(options.baseUrl.trim()) : '';
    this.enabled = !!this.baseUrl;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.setTimeout = options.setTimeout || globalThis.setTimeout?.bind(globalThis);
    this.clearTimeout = options.clearTimeout || globalThis.clearTimeout?.bind(globalThis);
    this.random = options.random || Math.random;
    this.batchSize = Math.max(1, Math.floor(options.batchSize || 50));
    this.batchIntervalMs = Math.max(0, Math.floor(options.batchIntervalMs ?? 250));
    this.maxQueue = Math.max(this.batchSize, Math.floor(options.maxQueue || 2000));
    this.retryBaseMs = Math.max(1, Math.floor(options.retryBaseMs || 500));
    this.retryMaxMs = Math.max(this.retryBaseMs, Math.floor(options.retryMaxMs || 30000));
    this.maxRetryAttempts = Math.max(1, Math.floor(options.maxRetryAttempts || 8));
    this.jitterRatio = Math.min(1, Math.max(0, options.jitterRatio ?? 0.2));

    if (this.enabled && typeof this.fetch !== 'function') throw new Error('fetch is unavailable');
    if (this.enabled && (typeof this.setTimeout !== 'function' || typeof this.clearTimeout !== 'function')) {
      throw new Error('timer functions are unavailable');
    }

    this.queue = [];
    this.inFlight = null;
    this.lingerTimer = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.authRenewedForBatch = false;
    this.droppedRecords = 0;
    this.terminalError = null;
    this.sessionId = '';
    this.userId = '';
    this.ingestUrl = '';
    this.expiresAt = null;
    // Keep the short-lived credential out of logs/JSON serialization. It is
    // never persisted and is erased when the uplink closes.
    Object.defineProperty(this, '_token', { value: '', writable: true, enumerable: false });
    Object.defineProperty(this, '_sessionEnvelope', { value: null, writable: true, enumerable: false });
    this._started = false;
    this._starting = null;
    this._accepting = true;
    this._closed = false;
    this._forceFlush = false;
    this._idleWaiters = [];
  }

  async start(sessionEnvelope) {
    if (!this.enabled) return { enabled: false };
    if (this._closed) throw new Error('Telemetry uplink is closed');
    if (this._started) {
      return { enabled: true, ingestUrl: this.ingestUrl, expiresAt: this.expiresAt };
    }
    if (this._starting) return this._starting;

    const envelope = clone(sessionEnvelope);
    const sessionId = requiredText(envelope?.sessionId, 'sessionId');
    const userId = requiredText(envelope?.user?.id, 'user.id');

    this._sessionEnvelope = envelope;
    this._starting = (async () => {
      await this._provision(envelope);
      this.sessionId = sessionId;
      this.userId = userId;
      this._started = true;
      this._scheduleDrain();
      return { enabled: true, ingestUrl: this.ingestUrl, expiresAt: this.expiresAt };
    })();

    try { return await this._starting; }
    finally { this._starting = null; }
  }

  async _provision(envelope) {
    const response = await this.fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error(`Telemetry session request failed (${response.status})`);
    const provision = await response.json();
    const token = requiredText(provision?.token, 'token');
    const rawIngestUrl = requiredText(provision?.ingestUrl, 'ingestUrl');

    this._token = token;
    this.ingestUrl = new URL(rawIngestUrl, `${this.baseUrl}/`).toString();
    this.expiresAt = provision.expiresAt ?? null;
  }

  enqueue(records) {
    if (!this.enabled || !this._accepting || this.terminalError) return 0;
    const list = Array.isArray(records) ? records : [records];
    let accepted = 0;

    for (const source of list) {
      if (!source || typeof source !== 'object') continue;
      requiredText(source.recordId, 'record.recordId');

      // Never mutate an in-flight batch. If capacity is exhausted, discard the
      // oldest still-pending record so live data remains current.
      while (this.queue.length && this._bufferedCount() >= this.maxQueue) {
        this.queue.shift();
        this.droppedRecords += 1;
      }
      if (this._bufferedCount() >= this.maxQueue) {
        this.droppedRecords += 1;
        continue;
      }
      this.queue.push(clone(source));
      accepted += 1;
    }

    this._scheduleDrain();
    return accepted;
  }

  async flush() {
    if (!this.enabled) return;
    if (this._starting) await this._starting;
    if (this.terminalError) throw this.terminalError;
    if (!this._started) {
      if (this.queue.length) throw new Error('Telemetry uplink has not started');
      return;
    }
    this._forceFlush = true;
    this._cancelLinger();
    this._drain(true);
    if (this._isIdle()) return;
    await new Promise((resolve, reject) => this._idleWaiters.push({ resolve, reject }));
  }

  async close() {
    if (this._closed) return;
    this._accepting = false;
    try { await this.flush(); }
    finally {
      this._closed = true;
      this._token = '';
      this._sessionEnvelope = null;
    }
  }

  status() {
    return {
      enabled: this.enabled,
      started: this._started,
      closed: this._closed,
      queuedRecords: this.queue.length,
      inFlightRecords: this.inFlight?.length || 0,
      droppedRecords: this.droppedRecords,
      retryAttempt: this.retryAttempt,
      terminalError: this.terminalError?.message || null,
    };
  }

  _bufferedCount() {
    return this.queue.length + (this.inFlight?.length || 0);
  }

  _isIdle() {
    return this.queue.length === 0 && !this.inFlight && !this.lingerTimer && !this.retryTimer;
  }

  _resolveIdle() {
    if (!this._isIdle()) return;
    this._forceFlush = false;
    const waiters = this._idleWaiters.splice(0);
    for (const waiter of waiters) waiter.resolve();
  }

  _failTerminal(error) {
    this.terminalError = error instanceof Error ? error : new Error(String(error));
    this._accepting = false;
    this._cancelLinger();
    if (this.retryTimer) {
      this.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const waiters = this._idleWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(this.terminalError);
  }

  _cancelLinger() {
    if (!this.lingerTimer) return;
    this.clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  _scheduleDrain() {
    if (!this.enabled || !this._started || this.terminalError || this.inFlight || this.retryTimer || !this.queue.length) {
      this._resolveIdle();
      return;
    }
    if (this._forceFlush || this.queue.length >= this.batchSize || this.batchIntervalMs === 0) {
      this._cancelLinger();
      this._drain(this._forceFlush || this.batchIntervalMs === 0);
      return;
    }
    if (this.lingerTimer) return;
    this.lingerTimer = this.setTimeout(() => {
      this.lingerTimer = null;
      this._drain(true);
    }, this.batchIntervalMs);
  }

  _drain(force = false) {
    if (!this.enabled || !this._started || this.inFlight || this.retryTimer) {
      this._resolveIdle();
      return;
    }
    if (!this.queue.length) {
      this._resolveIdle();
      return;
    }
    if (!force && this.queue.length < this.batchSize) {
      this._scheduleDrain();
      return;
    }
    this._cancelLinger();
    this.inFlight = this.queue.splice(0, this.batchSize);
    this.authRenewedForBatch = false;
    this._postInFlight();
  }

  async _postInFlight() {
    const batch = this.inFlight;
    try {
      const response = await this.fetch(this.ingestUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this._token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          schemaVersion: TELEMETRY_SCHEMA_VERSION,
          sessionId: this.sessionId,
          userId: this.userId,
          records: batch,
        }),
      });
      if (response.status === 401 && !this.authRenewedForBatch) {
        this.authRenewedForBatch = true;
        await this._provision(this._sessionEnvelope);
        return this._postInFlight();
      }
      if (!response.ok) throw new Error(`Telemetry ingest failed (${response.status})`);
      this.inFlight = null;
      this.retryAttempt = 0;
      this._scheduleDrain();
    } catch (error) {
      // Keep the exact cloned batch (and therefore every recordId) for retry.
      this.retryAttempt += 1;
      if (this.retryAttempt >= this.maxRetryAttempts) {
        this._failTerminal(error);
        return;
      }
      const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** (this.retryAttempt - 1)));
      const jitter = 1 + ((this.random() * 2) - 1) * this.jitterRatio;
      const delay = Math.min(this.retryMaxMs, Math.max(0, Math.round(exponential * jitter)));
      this.retryTimer = this.setTimeout(() => {
        this.retryTimer = null;
        this._postInFlight();
      }, delay);
    }
  }
}

export function createTelemetryUplink(options = {}) {
  return new TelemetryUplink(options);
}
