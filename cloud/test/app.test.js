import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createHttpServer } from '../src/app.js';
import { MemoryPublisher } from '../src/publisher.js';

const SESSION_ID = '83af3bca-4ac3-4ccf-a5b6-a63c3e825196';
const USER_ID = '0c469c68-aea2-45c1-9f6f-a545a058d918';
const NOW = 1_798_761_600;

const config = {
  tokenSecret: 'test-secret-with-more-than-thirty-two-bytes',
  tokenTtlSeconds: 900,
  tokenIssuer: 'formula-racing-live-ingest',
  tokenAudience: 'formula-racing-live-telemetry',
  allowedOrigins: new Set(['https://game.example']),
  maxBatchRecords: 3,
  maxBodyBytes: 32_768,
};

const envelope = {
  schemaVersion: 'formula-racing-live.telemetry.v1',
  sessionId: SESSION_ID,
  user: { id: USER_ID, displayName: 'Test Driver' },
  game: 'Formula Racing Live',
  createdAt: '2026-10-19T12:00:00.000Z',
  metadata: { mode: 'race', circuit: 'test' },
};

function record(sequence, overrides = {}) {
  return {
    schemaVersion: envelope.schemaVersion,
    recordId: `${SESSION_ID}:${sequence}`,
    sessionId: SESSION_ID,
    userId: USER_ID,
    sequence,
    type: 'telemetry',
    simulationTimeSeconds: sequence * 0.05,
    raceTimeSeconds: sequence * 0.05,
    cars: [],
    ...overrides,
  };
}

describe('telemetry ingest HTTP service', () => {
  let server;
  let baseUrl;
  let publisher;

  beforeEach(async () => {
    publisher = new MemoryPublisher();
    server = createHttpServer({ config, publisher, now: () => NOW, logger: { error() {} } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  async function json(path, options = {}) {
    const response = await fetch(`${baseUrl}${path}`, options);
    return { response, body: await response.json() };
  }

  async function createSession() {
    return json('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://game.example' },
      body: JSON.stringify(envelope),
    });
  }

  test('serves a health check without disclosing configuration', async () => {
    const { response, body } = await json('/healthz');
    assert.equal(response.status, 200);
    assert.deepEqual(body, { status: 'ok', schemaVersion: envelope.schemaVersion });
  });

  test('issues a short-lived token bound to the session and user', async () => {
    const { response, body } = await createSession();
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://game.example');
    assert.equal(body.sessionId, SESSION_ID);
    assert.equal(body.userId, USER_ID);
    assert.equal(body.token.split('.').length, 3);
    assert.equal(body.expiresAt, new Date((NOW + 900) * 1000).toISOString());
    assert.deepEqual(body.limits, { maxBatchRecords: 3, maxBodyBytes: 32_768 });
    assert.equal(publisher.sessions.length, 1);
    assert.deepEqual(publisher.sessions[0], envelope);
    assert.equal(publisher.sessions[0].user.displayName, 'Test Driver');
    assert.deepEqual(publisher.sessions[0].metadata, { mode: 'race', circuit: 'test' });
  });

  test('accepts validated records and publishes each record', async () => {
    const session = await createSession();
    const records = [record(0), record(1, { type: 'event', event: 'lap_completed', cars: undefined })];
    const { response, body } = await json('/v1/telemetry/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.body.token}` },
      body: JSON.stringify({ schemaVersion: envelope.schemaVersion, sessionId: SESSION_ID, userId: USER_ID, records }),
    });
    assert.equal(response.status, 202);
    assert.equal(body.accepted, 2);
    assert.equal(body.firstSequence, 0);
    assert.equal(body.lastSequence, 1);
    assert.deepEqual(publisher.messages.map(item => item.recordId), [`${SESSION_ID}:0`, `${SESSION_ID}:1`]);
  });

  test('rejects a disallowed browser origin', async () => {
    const { response, body } = await json('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(envelope),
    });
    assert.equal(response.status, 403);
    assert.equal(body.error, 'origin_not_allowed');
  });

  test('rejects invalid, expired, and cross-session bearer tokens', async () => {
    let result = await json('/v1/telemetry/batches', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer bad' }, body: '{}',
    });
    assert.equal(result.response.status, 401);

    const session = await createSession();
    const otherId = '8f94a213-2732-43bf-8728-150741c92717';
    result = await json('/v1/telemetry/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.body.token}` },
      body: JSON.stringify({ schemaVersion: envelope.schemaVersion, sessionId: otherId, userId: USER_ID, records: [] }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.field, 'sessionId');

    const expiredServer = createHttpServer({ config, publisher, now: () => NOW + 901, logger: { error() {} } });
    await new Promise(resolve => expiredServer.listen(0, '127.0.0.1', resolve));
    const expiredUrl = `http://127.0.0.1:${expiredServer.address().port}`;
    const expiredResponse = await fetch(`${expiredUrl}/v1/telemetry/batches`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.body.token}` }, body: '{}',
    });
    assert.equal(expiredResponse.status, 401);
    assert.equal((await expiredResponse.json()).error, 'expired_token');
    await new Promise(resolve => expiredServer.close(resolve));
  });

  test('enforces record count, binding, identity and ordered unique sequences', async () => {
    const session = await createSession();
    const send = records => json('/v1/telemetry/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.body.token}` },
      body: JSON.stringify({ schemaVersion: envelope.schemaVersion, sessionId: SESSION_ID, userId: USER_ID, records }),
    });

    let result = await send([record(1), record(0)]);
    assert.equal(result.response.status, 400);
    assert.match(result.body.message, /increasing/);

    result = await send([record(0), record(0)]);
    assert.equal(result.response.status, 400);
    assert.match(result.body.message, /duplicate/);

    result = await send([record(0, { userId: 'another-user' })]);
    assert.equal(result.response.status, 400);
    assert.match(result.body.message, /userId/);

    result = await send([record(0), record(1), record(2), record(3)]);
    assert.equal(result.response.status, 400);
    assert.match(result.body.message, /between 1 and 3/);

    result = await json('/v1/telemetry/batches', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.body.token}` },
      body: JSON.stringify({ sessionId: SESSION_ID, userId: USER_ID, records: [record(0)] }),
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.field, 'schemaVersion');
  });

  test('returns 413 before parsing an oversized request', async () => {
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...envelope, metadata: { padding: 'x'.repeat(40_000) } }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'body_too_large');
  });
});
