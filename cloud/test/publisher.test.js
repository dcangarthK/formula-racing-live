import assert from 'node:assert/strict';
import test from 'node:test';
import { PubSubPublisher } from '../src/publisher.js';

test('session envelope is published with a stable idempotency key and identity attributes', async () => {
  const published = [];
  const publisher = new PubSubPublisher({ projectId: 'test', topic: 'telemetry' });
  publisher.topic = { async publishMessage(message) { published.push(message); return 'message-1'; } };
  const envelope = {
    schemaVersion: 'formula-racing-live.telemetry.v1',
    sessionId: 'session-1',
    user: { id: 'user-1', displayName: 'Driver One' },
    createdAt: '2026-10-19T00:00:00.000Z',
    metadata: { circuit: 'harbor' },
  };

  assert.equal(await publisher.publishSession(envelope), 'message-1');
  assert.equal(published[0].attributes.idempotencyKey, 'session:session-1');
  assert.equal(published[0].attributes.userId, 'user-1');
  assert.deepEqual(published[0].json.session, envelope);
});

test('records carry recordId as the downstream idempotency key', async () => {
  const published = [];
  const publisher = new PubSubPublisher({ projectId: 'test', topic: 'telemetry' });
  publisher.topic = { async publishMessage(message) { published.push(message); return 'message-2'; } };
  const record = {
    schemaVersion: 'formula-racing-live.telemetry.v1',
    recordId: 'session-1:42', sessionId: 'session-1', userId: 'user-1', sequence: 42, type: 'event',
  };

  assert.deepEqual(await publisher.publish([record]), ['message-2']);
  assert.equal(published[0].attributes.idempotencyKey, 'session-1:42');
  assert.equal(published[0].attributes.sequence, '42');
  assert.equal(published[0].orderingKey, 'session-1');
});
