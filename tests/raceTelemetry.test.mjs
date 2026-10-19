import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FallbackTelemetryStore,
  MemoryTelemetryStore,
  RaceTelemetryRecorder,
  createTelemetryStore,
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
  assert.equal(capture.step(state, 0.101).filter(r => r.type === 'telemetry').length, 3);
  await capture.flush();
  const records = await capture.records();
  assert.deepEqual(records.filter(r => r.type === 'telemetry').map(r => r.simulationTimeSeconds), [0.05, 0.1, 0.15000000000000002]);
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
  assert.equal(json.records.length, 2);

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
