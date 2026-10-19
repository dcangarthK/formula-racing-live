import assert from 'node:assert/strict';
import test from 'node:test';
import { TelemetryUplink } from '../js/telemetryUplink.js';

const record = (id) => ({ recordId: id, type: 'telemetry', sequence: Number(id.slice(1)) });
const envelope = () => ({ sessionId: 'race-1', user: { id: 'user-1', displayName: 'Tester' } });
const response = (body = {}, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  async json() { return body; },
});
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('is a no-op when no endpoint is configured', async () => {
  let calls = 0;
  const uplink = new TelemetryUplink({ fetch: async () => { calls += 1; } });
  assert.deepEqual(await uplink.start(envelope()), { enabled: false });
  assert.equal(uplink.enqueue(record('r1')), 0);
  await uplink.flush();
  await uplink.close();
  assert.equal(calls, 0);
});

test('provisions a session and uploads ordered batches with one request in flight', async () => {
  const calls = [];
  const firstIngest = deferred();
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return response({ token: 'short-lived', ingestUrl: '/v1/ingest', expiresAt: 'soon' });
    if (calls.length === 2) return firstIngest.promise;
    return response();
  };
  const uplink = new TelemetryUplink({ baseUrl: 'https://telemetry.example.test/', fetch, batchSize: 2 });

  const provision = await uplink.start(envelope());
  assert.deepEqual(provision, {
    enabled: true,
    ingestUrl: 'https://telemetry.example.test/v1/ingest',
    expiresAt: 'soon',
  });
  assert.equal(calls[0].url, 'https://telemetry.example.test/v1/sessions');
  assert.deepEqual(JSON.parse(calls[0].options.body), envelope());

  uplink.enqueue([record('r1'), record('r2'), record('r3')]);
  await tick();
  assert.equal(calls.length, 2, 'second batch must wait for the first request');
  const sentFirst = JSON.parse(calls[1].options.body);
  assert.deepEqual(sentFirst.records.map(item => item.recordId), ['r1', 'r2']);
  assert.equal(calls[1].options.headers.authorization, 'Bearer short-lived');

  firstIngest.resolve(response());
  await tick();
  assert.equal(calls.length, 2, 'a partial follow-up batch should linger');
  const flushing = uplink.flush();
  await tick();
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    schemaVersion: 'formula-racing-live.telemetry.v1',
    sessionId: 'race-1', userId: 'user-1', records: [record('r3')],
  });
  await flushing;
});

test('retries the identical batch with capped exponential backoff and jitter', async () => {
  const ingestBodies = [];
  const timers = [];
  let ingestAttempt = 0;
  const fetch = async (_url, options) => {
    if (!options.headers.authorization) return response({ token: 'token', ingestUrl: 'ingest' });
    ingestBodies.push(options.body);
    ingestAttempt += 1;
    return ingestAttempt < 3 ? response({}, 503) : response();
  };
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test/root', fetch,
    batchSize: 1, retryBaseMs: 100, retryMaxMs: 150, jitterRatio: 0.2, random: () => 1,
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  await uplink.start(envelope());
  uplink.enqueue(record('r7'));
  await tick();
  assert.equal(timers[0].delay, 120);
  timers.shift().callback();
  await tick();
  assert.equal(timers[0].delay, 150, 'the final jittered delay must not exceed the cap');
  timers.shift().callback();
  await uplink.flush();
  assert.equal(ingestBodies.length, 3);
  assert.ok(ingestBodies.every(body => body === ingestBodies[0]), 'retry body must remain byte-for-byte stable');
  assert.equal(JSON.parse(ingestBodies[0]).records[0].recordId, 'r7');
});

test('bounds buffered records without mutating an in-flight batch', async () => {
  const calls = [];
  const pending = [];
  const fetch = async (_url, options) => {
    if (!options.headers.authorization) return response({ token: 'token', ingestUrl: '/ingest' });
    calls.push(JSON.parse(options.body));
    const request = deferred();
    pending.push(request);
    return request.promise;
  };
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test', fetch, batchSize: 1, maxQueue: 3,
  });
  await uplink.start(envelope());
  uplink.enqueue(record('r1'));
  uplink.enqueue([record('r2'), record('r3'), record('r4')]);
  assert.equal(uplink.droppedRecords, 1);
  assert.deepEqual(calls[0].records.map(item => item.recordId), ['r1']);

  pending.shift().resolve(response());
  await tick();
  assert.deepEqual(calls[1].records.map(item => item.recordId), ['r3']);
  pending.shift().resolve(response());
  await tick();
  assert.deepEqual(calls[2].records.map(item => item.recordId), ['r4']);
  pending.shift().resolve(response());
  await uplink.flush();
});

test('flush waits for delivery and close refuses later records while clearing credentials', async () => {
  const ingest = deferred();
  const fetch = async (_url, options) => options.headers.authorization
    ? ingest.promise
    : response({ token: 'ephemeral', ingestUrl: '/ingest' });
  const uplink = new TelemetryUplink({ baseUrl: 'https://api.example.test', fetch });
  await uplink.start(envelope());
  uplink.enqueue(record('r1'));
  let flushed = false;
  const flushing = uplink.flush().then(() => { flushed = true; });
  await tick();
  assert.equal(flushed, false);
  ingest.resolve(response());
  await flushing;
  await uplink.close();
  assert.equal(uplink.enqueue(record('r2')), 0);
  assert.equal(uplink._token, '');
});

test('validates provisioning and records without storing a permanent secret', async () => {
  const badProvision = new TelemetryUplink({
    baseUrl: 'https://api.example.test',
    fetch: async () => response({ ingestUrl: '/ingest' }),
  });
  await assert.rejects(() => badProvision.start(envelope()), /token is required/);

  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test',
    fetch: async () => response({ token: 'runtime-only', ingestUrl: '/ingest' }),
  });
  await uplink.start(envelope());
  assert.throws(() => uplink.enqueue({ type: 'event' }), /record.recordId is required/);
  assert.equal(JSON.stringify(uplink).includes('runtime-only'), false, 'token must not be enumerable/serializable');
});

test('coalesces partial traffic until the batch interval elapses', async () => {
  const calls = [];
  const timers = [];
  const fetch = async (_url, options) => {
    if (!options.headers.authorization) return response({ token: 'token', ingestUrl: '/ingest' });
    calls.push(JSON.parse(options.body));
    return response();
  };
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test', fetch, batchSize: 10, batchIntervalMs: 250,
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
  });
  await uplink.start(envelope());
  uplink.enqueue([record('r1'), record('r2'), record('r3'), record('r4'), record('r5')]);
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 250);
  timers[0].callback();
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].records.map(item => item.recordId), ['r1', 'r2', 'r3', 'r4', 'r5']);
  await uplink.flush();
});

test('flush cancels the linger timer and sends a partial batch immediately', async () => {
  const calls = [];
  const timers = [];
  const fetch = async (_url, options) => {
    if (!options.headers.authorization) return response({ token: 'token', ingestUrl: '/ingest' });
    calls.push(JSON.parse(options.body));
    return response();
  };
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test', fetch, batchSize: 10, batchIntervalMs: 500,
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
  });
  await uplink.start(envelope());
  uplink.enqueue([record('r1'), record('r2')]);
  assert.equal(timers[0].cancelled, false);
  await uplink.flush();
  assert.equal(timers[0].cancelled, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].records.map(item => item.recordId), ['r1', 'r2']);
});

test('reprovisions once after 401 and retries the exact batch with a renewed token', async () => {
  const calls = [];
  let provisions = 0;
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (!options.headers.authorization) {
      provisions += 1;
      return response({ token: `token-${provisions}`, ingestUrl: '/ingest', expiresAt: `expiry-${provisions}` });
    }
    return options.headers.authorization === 'Bearer token-1' ? response({}, 401) : response();
  };
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test', fetch, batchSize: 1,
  });
  await uplink.start(envelope());
  uplink.enqueue(record('r9'));
  await uplink.flush();

  assert.equal(provisions, 2);
  const ingests = calls.filter(call => call.options.headers.authorization);
  assert.equal(ingests.length, 2);
  assert.equal(ingests[0].options.headers.authorization, 'Bearer token-1');
  assert.equal(ingests[1].options.headers.authorization, 'Bearer token-2');
  assert.equal(ingests[0].options.body, ingests[1].options.body);
  const body = JSON.parse(ingests[1].options.body);
  assert.equal(body.schemaVersion, 'formula-racing-live.telemetry.v1');
  assert.equal(body.records[0].recordId, 'r9');
  assert.equal(JSON.stringify(uplink).includes('Tester'), false, 'session envelope must remain non-enumerable');
});

test('enters a terminal state after bounded retries and rejects flush and close', async () => {
  const timers = [];
  const fetch = async (_url, options) => options.headers.authorization
    ? response({}, 503)
    : response({ token: 'ephemeral', ingestUrl: '/ingest' });
  const uplink = new TelemetryUplink({
    baseUrl: 'https://api.example.test', fetch, batchSize: 1, maxRetryAttempts: 2,
    retryBaseMs: 10, jitterRatio: 0,
    setTimeout(callback, delay) { const timer = { callback, delay, cancelled: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cancelled = true; },
  });
  await uplink.start(envelope());
  uplink.enqueue(record('r1'));
  await tick();
  assert.equal(timers.length, 1);
  timers[0].callback();
  await tick();

  const state = uplink.status();
  assert.match(state.terminalError, /503/);
  assert.equal(state.inFlightRecords, 1, 'failed records remain available at the persistence boundary');
  assert.equal(state.retryAttempt, 2);
  assert.equal(uplink.enqueue(record('r2')), 0);
  await assert.rejects(() => uplink.flush(), /503/);
  await assert.rejects(() => uplink.close(), /503/);
  assert.equal(uplink.status().closed, true);
  assert.equal(uplink._token, '');
  assert.equal(timers.length, 1, 'terminal failure must not create another retry timer');
});
