import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDriverIdentity, normalizeDisplayName } from '../js/driverIdentity.js';

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function identityOptions(storage, uuids = UUIDS) {
  let index = 0;
  return {
    storage,
    generateUuid: () => uuids[index++],
    now: () => '2026-10-19T12:00:00.000Z',
  };
}

describe('driver identity', () => {
  it('persists an opaque UUID independently of the display name', () => {
    const storage = memoryStorage();
    const first = createDriverIdentity(identityOptions(storage));
    const original = first.setDisplayName('  Ada   Racer  ');
    const reloaded = createDriverIdentity(identityOptions(storage, [UUIDS[2]])).getProfile();

    assert.deepEqual(original, { userId: UUIDS[0], displayName: 'Ada Racer' });
    assert.deepEqual(reloaded, original);

    const renamed = first.setDisplayName('Grace Driver');
    assert.equal(renamed.userId, original.userId);
    assert.equal(renamed.displayName, 'Grace Driver');
  });

  it('normalizes empty, long, and non-string display names', () => {
    assert.equal(normalizeDisplayName('  Team\n  Driver  '), 'Team Driver');
    assert.equal(normalizeDisplayName('   '), 'Driver');
    assert.equal(normalizeDisplayName(null), 'Driver');
    assert.equal(normalizeDisplayName('x'.repeat(60)).length, 48);
  });

  it('creates a fresh session UUID for every race or qualifying launch', () => {
    const identity = createDriverIdentity(identityOptions(memoryStorage()));
    const race = identity.createSession('race');
    const quali = identity.createSession('quali');

    assert.equal(race.userId, quali.userId);
    assert.notEqual(race.sessionId, quali.sessionId);
    assert.equal(race.sessionType, 'race');
    assert.equal(quali.sessionType, 'quali');
    assert.equal(race.startedAt, '2026-10-19T12:00:00.000Z');
  });

  it('rejects unsupported session types', () => {
    const identity = createDriverIdentity(identityOptions(memoryStorage()));
    assert.throws(() => identity.createSession('practice'), /race.*quali/);
  });

  it('continues safely when localStorage access throws', () => {
    const unavailableStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('quota exceeded'); },
    };
    const identity = createDriverIdentity(identityOptions(unavailableStorage));
    const first = identity.getProfile();
    const updated = identity.setDisplayName('Local Driver');

    assert.equal(updated.userId, first.userId);
    assert.equal(identity.getProfile().displayName, 'Local Driver');
  });

  it('replaces corrupt persisted identity instead of deriving one from a name', () => {
    const storage = memoryStorage();
    storage.setItem('formula_racing_live_driver_v1', JSON.stringify({
      version: 1,
      userId: 'Ada Racer',
      displayName: 'Ada Racer',
    }));
    const profile = createDriverIdentity(identityOptions(storage)).getProfile();

    assert.equal(profile.userId, UUIDS[0]);
    assert.equal(profile.displayName, 'Driver');
  });
});
