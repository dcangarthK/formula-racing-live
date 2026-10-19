import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FallbackTelemetryStore,
  MemoryTelemetryStore,
  RaceTelemetryRecorder,
  createTelemetryStore,
  normalizeSessionType,
  parseGapSeconds,
  serializeLiveSession,
  TELEMETRY_TIERS,
  serializePlayerEngineering,
  selectSessionsToPrune,
  serializeRaceSession,
} from '../js/raceTelemetry.js';

function entry(id, position = 1) {
  return {
    driver: { id, code: id.toUpperCase(), num: position, firstName: id, lastName: 'Driver', team: `team-${id}` },
    team: { id: `team-${id}`, name: `Team ${id}` },
    isPlayer: position === 1,
    position, gridPos: position, lap: 0, lapTimes: [], lastLap: 0, bestLap: 0,
    sectors: [null, null, null], lastSectors: [null, null, null],
    pitStops: 0, pitState: null, penaltySeconds: 0, trackLimits: 0,
    finished: false, dnf: false,
    phys: {
      pos: { x: position, y: 0, z: 10 }, heading: 0.4, sampleIdx: 20,
      v: 50, kmh: 180, gear: 6, rpmFrac: 0.8, throttle: 1, brake: 0, steer: 0.1,
      battery: 0.7, ersMode: 2, ersDeploy: 100000, fuel: 0.8,
      compound: 'M', wear: 0.1, tyreGrip: 0.98, tyreTemp: 95,
      surface: { wetness: 0.1 }, wheels: [{ key: 'FL', slipRatio: 0.02, contact: true }],
    },
  };
}

function session() {
  return {
    mode: 'race', phase: 'racing', raceTime: 0, laps: 3,
    circuit: { id: 'test', name: 'Test Circuit', length: 5000 },
    conditions: { wetness: 0.1, trackGrip: 0.95 },
    raceControl: { state: 'green', noOvertake: false },
    entries: [entry('one', 1), entry('two', 2)], results: null,
  };
}

function recorder(store = new MemoryTelemetryStore()) {
  return new RaceTelemetryRecorder({
    sessionId: 'session-1', userId: 'user-1', userDisplayName: 'Tester',
    createdAt: '2026-10-19T00:00:00.000Z', store,
  });
}

test('serializes authoritative telemetry for every car', () => {
  const snapshot = serializeRaceSession(session());
  assert.equal(snapshot.cars.length, 2);
  assert.equal(snapshot.cars[0].car.speedKph, 180);
  assert.equal(snapshot.cars[0].car.wheels[0].key, 'FL');
  assert.equal(snapshot.cars[1].driver.id, 'two');
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('samples at 20 Hz from caller-provided dt without dropping scheduled samples', async () => {
  const state = session();
  const capture = recorder();
  capture.begin(state);
  assert.equal(capture.step(state, 0.049).filter(r => r.type === 'telemetry').length, 0);
  // Each scheduled sample projects the archive tier; live and engineering are
  // projections of that same instant, so the archive tier carries the cadence.
  assert.equal(capture.step(state, 0.101).filter(r => r.tier === 'archive').length, 3);
  await capture.flush();
  const records = await capture.records();
  assert.deepEqual(records.filter(r => r.tier === 'archive').map(r => r.simulationTimeSeconds), [0.05, 0.1, 0.15000000000000002]);
});

test('detects all required race state transitions once', async () => {
  const state = session();
  const capture = recorder();
  capture.begin(state);
  const car = state.entries[0];

  car.position = 2;
  car.sectors[0] = 30;
  car.pitStops = 1;
  car.pitState = { phase: 'entry' };
  car.penaltySeconds = 5;
  let events = capture.step(state, 0).filter(r => r.type === 'event').map(r => r.event);
  assert.deepEqual(events, ['sector_completed', 'position_changed', 'pit_entered', 'penalty_changed']);

  car.lap = 1;
  car.lapTimes.push(90);
  car.lastLap = 90;
  car.bestLap = 90;
  car.lastSectors = [30, 29, 31];
  car.sectors = [null, null, null];
  car.pitState = null;
  events = capture.step(state, 0).filter(r => r.type === 'event').map(r => r.event);
  assert.deepEqual(events, ['lap_completed', 'sector_completed', 'sector_completed', 'pit_exited']);

  car.finished = true;
  car.finishTime = 270;
  state.entries[1].dnf = true;
  state.entries[1].failureCause = 'engine';
  state.entries[1].retirementTime = 250;
  events = capture.step(state, 0).filter(r => r.type === 'event').map(r => r.event);
  assert.deepEqual(events, ['car_finished', 'car_dnf']);

  state.results = [
    { pos: 1, driver: car.driver, team: car.team, status: 'FINISHED', laps: 3, bestLap: 90, points: 25 },
    { pos: 2, driver: state.entries[1].driver, team: state.entries[1].team, status: 'DNF', laps: 2, failureCause: 'engine' },
  ];
  events = capture.step(state, 0).filter(r => r.type === 'event').map(r => r.event);
  assert.deepEqual(events, ['race_finished']);
  assert.equal(capture.step(state, 0).filter(r => r.type === 'event').length, 0);
  await capture.flush();
});

test('persists records and exports valid JSON and NDJSON with identity envelope', async () => {
  const store = new MemoryTelemetryStore();
  const capture = recorder(store);
  const state = session();
  capture.begin(state);
  capture.step(state, 0.05);
  await capture.flush();

  const json = JSON.parse(await capture.exportJSON());
  assert.equal(json.session.user.id, 'user-1');
  assert.equal(json.session.sessionId, 'session-1');
  // Only the durable tiers are stored: live and engineering are streamed
  // projections of the archive snapshot, so storing them would triple the
  // local copy of the same simulation.
  assert.equal(json.records.length, 2);
  assert.deepEqual(json.records.map(record => record.tier), ['events', 'archive']);

  const lines = (await capture.exportNDJSON()).trim().split('\n').map(JSON.parse);
  assert.equal(lines[0].type, 'session');
  assert.equal(lines[1].event, 'session_started');
  assert.equal(lines[2].type, 'telemetry');
});

test('uses memory persistence when IndexedDB is unavailable', () => {
  assert.ok(createTelemetryStore({ indexedDB: null }) instanceof MemoryTelemetryStore);
});

test('falls back to memory when IndexedDB fails at runtime', async () => {
  const primary = { async appendBatch() { throw new Error('blocked'); } };
  const store = new FallbackTelemetryStore(primary);
  const capture = recorder(store);
  capture.begin(session());
  await capture.flush();
  assert.equal((await capture.records()).length, 1);
  assert.equal(store.primaryFailed, true);
});

test('validates required identity and dt', () => {
  assert.throws(() => new RaceTelemetryRecorder({ sessionId: '', userId: 'user' }), /sessionId/);
  const capture = recorder();
  assert.throws(() => capture.step(session(), -0.1), /dt/);
});

test('reports the venue name even when it is only a non-enumerable circuit property', () => {
  const state = session();
  state.circuit = Object.defineProperties(
    { id: 'monza', length: 5801 },
    { publicName: { value: 'Autodromo Nazionale', enumerable: false } },
  );
  assert.equal(serializeRaceSession(state).circuit.name, 'Autodromo Nazionale');
});

test('distinguishes a time trial from qualifying and stamps every record', async () => {
  assert.equal(normalizeSessionType(null, 'quali', true), 'time_trial');
  assert.equal(normalizeSessionType(null, 'quali', false), 'qualifying');
  assert.equal(normalizeSessionType(null, 'race', false), 'race');
  assert.equal(normalizeSessionType('time_trial', 'race', false), 'time_trial');
  assert.equal(normalizeSessionType('nonsense', 'race', false), 'race');

  const capture = new RaceTelemetryRecorder({
    sessionId: 'session-1', userId: 'user-1', userDisplayName: 'Tester',
    store: new MemoryTelemetryStore(), metadata: { mode: 'quali', trial: true },
  });
  assert.equal(capture.envelope.sessionType, 'time_trial');
  const state = session();
  capture.begin(state);
  capture.step(state, 0.05);
  await capture.flush();
  assert.ok((await capture.records()).every(record => record.sessionType === 'time_trial'));
});

test('ends the session once with a reason and the laps actually completed', async () => {
  const state = session();
  const capture = recorder();
  capture.begin(state);
  state.entries[0].lapTimes.push(90, 88, 91);
  state.entries[0].bestLap = 88;
  state.entries[1].lapTimes.push(92);
  capture.step(state, 0.05);

  const [ended] = capture.end(state, { reason: 'abandoned' });
  assert.equal(ended.event, 'session_ended');
  assert.equal(ended.reason, 'abandoned');
  assert.equal(ended.completedLaps, 3);
  assert.equal(ended.playerCompletedLaps, 3);
  assert.equal(ended.playerBestLapSeconds, 88);
  assert.equal(ended.classified, false);
  assert.deepEqual(capture.end(state), []);

  await capture.flush();
  const records = await capture.records();
  assert.equal(records.filter(record => record.event === 'session_ended').length, 1);
  assert.equal(records.at(-1).event, 'session_ended');
  assert.ok(records.every((record, index) => index === 0 || record.sequence > records[index - 1].sequence));
});

test('classifies the session end when the race produced results', () => {
  const state = session();
  state.results = [{ pos: 1, driver: state.entries[0].driver, team: state.entries[0].team, status: 'FINISHED', laps: 3 }];
  const capture = recorder();
  capture.begin(state);
  const [ended] = capture.end(state);
  assert.equal(ended.reason, 'classified');
  assert.equal(ended.classified, true);
});

test('keeps no in-memory duplicate while IndexedDB is healthy', async () => {
  const persisted = new MemoryTelemetryStore();
  const shadow = new MemoryTelemetryStore();
  const store = new FallbackTelemetryStore(persisted, shadow);
  const capture = recorder(store);
  const state = session();
  capture.begin(state);
  capture.step(state, 0.05);
  await capture.flush();

  assert.equal(shadow.records.length, 0);
  assert.deepEqual(persisted.records.map(record => record.tier), ['events', 'archive']);
  assert.equal((await capture.records()).length, 2);
});

test('merges records persisted before an IndexedDB failure with the memory fallback', async () => {
  const persisted = new MemoryTelemetryStore();
  let blocked = false;
  const primary = {
    async appendBatch(records) {
      if (blocked) throw new Error('quota exceeded');
      await persisted.appendBatch(records);
    },
    async readSession(sessionId) { return persisted.readSession(sessionId); },
    async clearSession(sessionId) { return persisted.clearSession(sessionId); },
  };
  const store = new FallbackTelemetryStore(primary);
  const capture = recorder(store);
  const state = session();
  capture.begin(state);
  capture.step(state, 0.05);
  await capture.flush();
  blocked = true;
  capture.step(state, 0.05);
  await capture.flush();

  const records = await capture.records();
  assert.equal(store.primaryFailed, true);
  assert.deepEqual(records.map(record => record.sequence), [0, 3, 5]);
});

test('retains only the newest sessions and never the one being recorded', () => {
  const sessions = [
    { sessionId: 'oldest', createdAt: '2026-10-19T10:00:00.000Z' },
    { sessionId: 'older', createdAt: '2026-10-19T11:00:00.000Z' },
    { sessionId: 'recent', createdAt: '2026-10-19T12:00:00.000Z' },
    { sessionId: 'newest', createdAt: '2026-10-19T13:00:00.000Z' },
  ];
  assert.deepEqual(selectSessionsToPrune(sessions, 2, 'newest'), ['older', 'oldest']);
  assert.deepEqual(selectSessionsToPrune(sessions, 3, 'oldest'), ['older']);
  assert.deepEqual(selectSessionsToPrune(sessions, 1, 'oldest'), ['newest', 'recent', 'older']);
  assert.deepEqual(selectSessionsToPrune([], 3, 'only'), []);
});

test('projects a slim all-car live tier with numeric gaps', () => {
  const state = session();
  state.entries[0].gapText = 'LEADER';
  state.entries[0].intervalText = '';
  state.entries[1].gapText = '+12.4';
  state.entries[1].intervalText = '+12.4';
  const live = serializeLiveSession(state);

  assert.equal(live.cars.length, 2);
  assert.deepEqual(live.cars[1], {
    driverId: 'two', teamId: 'team-two', isPlayer: false, position: 2, lap: 0,
    trackSampleIndex: 20, positionXM: 2, positionZM: 10, speedKph: 180,
    gapToLeaderSeconds: 12.4, lapsDown: 0, intervalSeconds: 12.4,
    lastLapSeconds: 0, bestLapSeconds: 0, tyreCompound: 'M', tyreWearFraction: 0.1,
    pitState: null, pitStops: 0, penaltySeconds: 0, finished: false, dnf: false,
  });
  assert.equal(live.cars[0].gapToLeaderSeconds, 0);
  assert.ok(!('wheels' in live.cars[0]), 'live tier must not carry per-wheel detail');

  assert.deepEqual(parseGapSeconds('PIT'), { seconds: null, laps: null });
  assert.deepEqual(parseGapSeconds('+2L'), { seconds: null, laps: 2 });
  assert.deepEqual(parseGapSeconds(''), { seconds: 0, laps: 0 });
});

test('projects the engineering tier for the player car only', () => {
  const engineering = serializePlayerEngineering(session());
  assert.equal(engineering.driverId, 'one');
  assert.equal(engineering.car.wheels[0].key, 'FL');
  assert.equal(engineering.car.speedKph, 180);
  assert.ok(!('cars' in engineering));
  assert.equal(serializePlayerEngineering({ entries: [] }), null);
});

test('emits live at 5 Hz, engineering and archive at 20 Hz, phase-locked', async () => {
  const state = session();
  const capture = recorder();
  capture.begin(state);
  const samples = capture.step(state, 0.4).filter(record => record.type === 'telemetry');

  const byTier = tier => samples.filter(record => record.tier === tier);
  assert.equal(byTier('engineering').length, 8);
  assert.equal(byTier('archive').length, 8);
  assert.deepEqual(byTier('live').map(record => Number(record.simulationTimeSeconds.toFixed(2))), [0.05, 0.25]);
  // A live sample is always also an engineering sample at the same instant.
  for (const record of byTier('live')) {
    assert.ok(byTier('engineering').some(other => other.simulationTimeSeconds === record.simulationTimeSeconds));
  }
  assert.ok(samples.every(record => TELEMETRY_TIERS.includes(record.tier)));
  await capture.flush();
});

test('tags events with the events tier and honours a configured live rate', () => {
  const state = session();
  const capture = new RaceTelemetryRecorder({
    sessionId: 'session-1', userId: 'user-1', store: new MemoryTelemetryStore(),
    liveHz: 10, archive: false,
  });
  const started = capture.begin(state);
  assert.equal(started[0].tier, 'events');

  const samples = capture.step(state, 0.2).filter(record => record.type === 'telemetry');
  assert.equal(samples.filter(record => record.tier === 'live').length, 2);
  assert.equal(samples.filter(record => record.tier === 'archive').length, 0);
  assert.throws(() => new RaceTelemetryRecorder({
    sessionId: 's', userId: 'u', liveHz: 40, store: new MemoryTelemetryStore(),
  }), /liveHz/);
});
