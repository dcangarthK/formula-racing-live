import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRACT_VERSION,
  applyRecord,
  buildRaceReport,
  createLiveState,
  eventLabel,
  formatLapTime,
} from '../dashboards/src/contract.js';

const SESSION = 'session-1';

function record(sequence, tier, extra = {}) {
  return {
    tier,
    schemaVersion: 'formula-racing-live.telemetry.v1',
    recordId: `${SESSION}:${sequence}`,
    sessionId: SESSION,
    userId: 'user-1',
    sequence,
    sessionType: 'race',
    type: tier === 'events' ? 'event' : 'telemetry',
    simulationTimeSeconds: sequence * 0.05,
    raceTimeSeconds: sequence * 0.05,
    ...extra,
  };
}

const roster = [
  { driverId: 'one', code: 'ONE', number: 1, firstName: 'Driver', lastName: 'One', teamId: 'alpha', teamName: 'Alpha', isPlayer: true, gridPosition: 1 },
  { driverId: 'two', code: 'TWO', number: 2, firstName: 'Driver', lastName: 'Two', teamId: 'beta', teamName: 'Beta', isPlayer: false, gridPosition: 2 },
];

const started = record(0, 'events', {
  event: 'session_started', mode: 'race', configuredLaps: 3,
  circuit: { id: 'monza', name: 'Autodromo Nazionale Monza', lengthM: 5801 },
  roster,
});

function liveRecord(sequence, cars, extra = {}) {
  return record(sequence, 'live', {
    phase: 'racing', circuitId: 'monza',
    conditions: { wetness: 0, trackGrip: 1 },
    raceControl: { state: 'green', noOvertake: false },
    cars, ...extra,
  });
}

const car = (driverId, position, extra = {}) => ({
  driverId, teamId: driverId === 'one' ? 'alpha' : 'beta', isPlayer: driverId === 'one',
  position, lap: 1, trackSampleIndex: 10, positionXM: 0, positionZM: 0, speedKph: 280,
  gapToLeaderSeconds: position === 1 ? 0 : 1.2, lapsDown: 0, intervalSeconds: 1.2,
  lastLapSeconds: 90, bestLapSeconds: 89, tyreCompound: 'M', tyreWearFraction: 0.2,
  pitState: null, pitStops: 0, penaltySeconds: 0, finished: false, dnf: false, ...extra,
});

test('builds live state from the record stream', () => {
  const state = createLiveState(SESSION);
  applyRecord(state, started);
  applyRecord(state, liveRecord(1, [car('two', 2), car('one', 1)]));

  assert.equal(state.contractVersion, CONTRACT_VERSION);
  assert.equal(state.status, 'running');
  assert.equal(state.circuit.name, 'Autodromo Nazionale Monza');
  assert.equal(state.configuredLaps, 3);
  assert.deepEqual(state.cars.map(entry => entry.position), [1, 2], 'cars are ordered by position');
  // The roster is sent once; the live tier carries ids, so the state joins them.
  assert.equal(state.cars[0].code, 'ONE');
  assert.equal(state.cars[0].teamName, 'Alpha');
  assert.equal(state.lastSequence, 1);
});

test('ignores a stale sample rather than rewinding the screen', () => {
  const state = createLiveState(SESSION);
  applyRecord(state, started);
  applyRecord(state, liveRecord(40, [car('one', 1)]));
  applyRecord(state, liveRecord(20, [car('two', 1, { speedKph: 10 })]));

  assert.equal(state.simulationTimeSeconds, 2);
  assert.equal(state.cars[0].driverId, 'one');
});

test('ignores records belonging to another session', () => {
  const state = createLiveState(SESSION);
  applyRecord(state, started);
  applyRecord(state, { ...liveRecord(5, [car('two', 1)]), sessionId: 'other' });
  assert.equal(state.cars.length, 0);
});

test('tracks the player engineering trace separately from the tower', () => {
  const state = createLiveState(SESSION);
  applyRecord(state, started);
  applyRecord(state, record(2, 'engineering', {
    driverId: 'one', teamId: 'alpha', race: { lap: 2 },
    car: { speedKph: 310, throttle: 1, brake: 0, gear: 7, batteryFraction: 0.6, wheels: [] },
  }));

  assert.equal(state.player.driverId, 'one');
  assert.equal(state.player.speedKph, 310);
  assert.equal(state.player.lap, 2);
});

test('surfaces session end and keeps a human-readable feed', () => {
  const state = createLiveState(SESSION);
  applyRecord(state, started);
  applyRecord(state, record(3, 'events', { event: 'lap_completed', driverId: 'one', lapNumber: 1, lapTimeSeconds: 89.123 }));
  applyRecord(state, record(4, 'events', { event: 'position_changed', driverId: 'two', from: 2, to: 1 }));
  applyRecord(state, record(5, 'events', { event: 'session_ended', reason: 'classified', completedLaps: 3, classified: true }));

  assert.equal(state.status, 'finished');
  assert.deepEqual(state.endedAt, { reason: 'classified', completedLaps: 3, classified: true });
  // Position changes are noise in a feed a human reads; laps are not.
  assert.deepEqual(state.events.map(event => event.event), ['session_ended', 'lap_completed', 'session_started']);
  assert.equal(state.events[1].label, 'ONE lap 1 — 1:29.123');
});

test('formats lap times the way a timing tower does', () => {
  assert.equal(formatLapTime(89.123), '1:29.123');
  assert.equal(formatLapTime(45.5), '45.500');
  assert.equal(formatLapTime(0), '—');
  assert.equal(formatLapTime(undefined), '—');
  assert.equal(eventLabel({ event: 'car_dnf', driverId: 'two', cause: 'engine' }, { two: { code: 'TWO' } }), 'TWO retires — engine');
});

test('builds the post-race report from the event stream alone', () => {
  const events = [
    started,
    record(10, 'events', { event: 'sector_completed', driverId: 'one', lapNumber: 1, sector: 1, sectorTimeSeconds: 29 }),
    record(11, 'events', { event: 'sector_completed', driverId: 'one', lapNumber: 1, sector: 2, sectorTimeSeconds: 30 }),
    record(12, 'events', { event: 'sector_completed', driverId: 'one', lapNumber: 1, sector: 3, sectorTimeSeconds: 31 }),
    record(13, 'events', { event: 'lap_completed', driverId: 'one', lapNumber: 1, lapTimeSeconds: 90 }),
    record(14, 'events', { event: 'lap_completed', driverId: 'one', lapNumber: 2, lapTimeSeconds: 88 }),
    record(15, 'events', { event: 'lap_completed', driverId: 'two', lapNumber: 1, lapTimeSeconds: 95 }),
    record(16, 'events', {
      event: 'race_finished',
      classification: [
        { position: 1, driverId: 'one', teamId: 'alpha', status: 'FINISHED', laps: 3, bestLapSeconds: 88, points: 25 },
        { position: 2, driverId: 'two', teamId: 'beta', status: 'FINISHED', laps: 3, bestLapSeconds: 95, points: 18 },
      ],
    }),
    record(17, 'events', { event: 'session_ended', reason: 'classified', completedLaps: 3, classified: true }),
  ];

  const report = buildRaceReport(events, { sessionId: SESSION });
  assert.equal(report.status, 'classified');
  assert.equal(report.circuit.name, 'Autodromo Nazionale Monza');
  assert.equal(report.classification.length, 2);
  assert.equal(report.classification[0].code, 'ONE', 'classification is joined to the roster');
  assert.equal(report.laps.length, 3);
  assert.deepEqual(report.laps[0].sectorsSeconds, [29, 30, 31]);
  assert.equal(report.player.driverId, 'one', 'the player is found from the roster');
  assert.equal(report.player.laps, 2);
  assert.equal(report.player.bestLapSeconds, 88);
  assert.equal(report.player.averageLapSeconds, 89);
  assert.ok(report.player.consistency > 0.8 && report.player.consistency <= 1);
  assert.equal(report.fastestLap.lapTimeSeconds, 88);
  assert.equal(report.debrief, null, 'the AI layer fills this in, and is optional');
  assert.ok(report.events.every(event => !['position_changed', 'sector_completed'].includes(event.event)));
});

test('reports an abandoned session without inventing a classification', () => {
  const report = buildRaceReport([
    started,
    record(5, 'events', { event: 'session_ended', reason: 'abandoned', completedLaps: 1, classified: false }),
  ], { sessionId: SESSION });

  assert.equal(report.status, 'abandoned');
  assert.deepEqual(report.classification, []);
  assert.equal(report.completedLaps, 1);
});
