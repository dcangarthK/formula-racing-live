// Exercises the reference serving layer the way the game and the dashboards
// do: post a session, post batches, read the live stream and the race report.
// It is the executable statement of the contract a team has to satisfy.

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSION = 'contract-test-session';
const USER = 'contract-test-user';

function record(sequence, tier, extra = {}) {
  return {
    tier,
    schemaVersion: 'formula-racing-live.telemetry.v1',
    recordId: `${SESSION}:${sequence}`,
    sessionId: SESSION,
    userId: USER,
    sequence,
    sessionType: 'race',
    type: tier === 'events' ? 'event' : 'telemetry',
    simulationTimeSeconds: sequence * 0.2,
    raceTimeSeconds: sequence * 0.2,
    ...extra,
  };
}

const roster = [
  { driverId: 'one', code: 'ONE', number: 1, firstName: 'Driver', lastName: 'One', teamId: 'alpha', teamName: 'Alpha', isPlayer: true, gridPosition: 1 },
  { driverId: 'two', code: 'TWO', number: 2, firstName: 'Driver', lastName: 'Two', teamId: 'beta', teamName: 'Beta', isPlayer: false, gridPosition: 2 },
];

const car = (driverId, position) => ({
  driverId, teamId: driverId === 'one' ? 'alpha' : 'beta', isPlayer: driverId === 'one',
  position, lap: 1, trackSampleIndex: 10, positionXM: 1, positionZM: 2, speedKph: 250,
  gapToLeaderSeconds: position === 1 ? 0 : 2.5, lapsDown: 0, intervalSeconds: 2.5,
  lastLapSeconds: 91, bestLapSeconds: 91, tyreCompound: 'M', tyreWearFraction: 0.1,
  pitState: null, pitStops: 0, penaltySeconds: 0, finished: false, dnf: false,
});

async function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'tools/contract-server.mjs')], {
    env: { ...process.env, PORT: '0', FIXTURE_DIR: path.join(root, 'tests/.no-fixture') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The server prints its URLs once it is listening; PORT=0 asks the OS for a
  // free one, so the port has to be read back rather than assumed.
  let port = 0;
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    const match = chunk.match(/127\.0\.0\.1:(\d+)/);
    if (match) { port = Number(match[1]); break; }
  }
  return { child, base: `http://127.0.0.1:${port}` };
}

test('serves the dashboard contract over records the game posts', async (t) => {
  const { child, base } = await startServer();
  t.after(async () => { child.kill(); await once(child, 'exit'); });

  const provision = await fetch(`${base}/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schemaVersion: 'formula-racing-live.telemetry.v1',
      sessionId: SESSION,
      user: { id: USER, displayName: 'Tester' },
      sessionType: 'race',
      createdAt: new Date().toISOString(),
      metadata: { trackId: 'monza' },
    }),
  });
  assert.equal(provision.status, 201);
  const credentials = await provision.json();
  assert.ok(credentials.token, 'the game needs a token back before it will send records');

  const post = async records => {
    const response = await fetch(`${base}/v1/telemetry/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credentials.token}` },
      body: JSON.stringify({ schemaVersion: 'formula-racing-live.telemetry.v1', sessionId: SESSION, userId: USER, records }),
    });
    assert.equal(response.status, 202);
    return response.json();
  };

  const started = record(0, 'events', {
    event: 'session_started', mode: 'race', configuredLaps: 2,
    circuit: { id: 'monza', name: 'Autodromo Nazionale Monza', lengthM: 5801 },
    roster,
  });
  await post([started, record(1, 'live', {
    phase: 'racing', circuitId: 'monza',
    conditions: { wetness: 0, trackGrip: 1 },
    raceControl: { state: 'green', noOvertake: false },
    cars: [car('one', 1), car('two', 2)],
  })]);

  const sessions = (await (await fetch(`${base}/api/v1/sessions`)).json()).sessions;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionId, SESSION);
  assert.equal(sessions[0].status, 'running');
  assert.equal(sessions[0].circuit.name, 'Autodromo Nazionale Monza');

  // The live stream must hand a late joiner the race as it stands, not an
  // empty screen waiting for the next sample.
  const stream = await fetch(`${base}/api/v1/live/${SESSION}`);
  const reader = stream.body.getReader();
  const firstFrame = new TextDecoder().decode((await reader.read()).value);
  const state = JSON.parse(firstFrame.replace(/^data: /, ''));
  assert.equal(state.cars.length, 2);
  assert.equal(state.cars[0].code, 'ONE', 'the roster is joined onto the live rows');
  assert.equal(state.circuit.name, 'Autodromo Nazionale Monza');
  assert.ok(state.servedAt, 'servedAt is what the dashboard measures latency with');

  // At-least-once delivery is normal; the same record must not count twice.
  const repeat = await post([started]);
  assert.equal(repeat.accepted, 0);

  await post([
    record(2, 'events', { event: 'lap_completed', driverId: 'one', lapNumber: 1, lapTimeSeconds: 91.5 }),
    record(3, 'events', {
      event: 'race_finished',
      classification: [
        { position: 1, driverId: 'one', teamId: 'alpha', status: 'FINISHED', laps: 2, bestLapSeconds: 91.5, points: 25 },
        { position: 2, driverId: 'two', teamId: 'beta', status: 'FINISHED', laps: 2, bestLapSeconds: 93, points: 18 },
      ],
    }),
    record(4, 'events', { event: 'session_ended', reason: 'classified', completedLaps: 2, classified: true }),
  ]);
  await reader.cancel();

  const report = await (await fetch(`${base}/api/v1/race/${SESSION}`)).json();
  assert.equal(report.status, 'classified');
  assert.equal(report.completedLaps, 2);
  assert.equal(report.classification.length, 2);
  assert.equal(report.classification[0].lastName, 'One');
  assert.equal(report.player.bestLapSeconds, 91.5);
  assert.equal(report.laps.length, 1);

  const health = await (await fetch(`${base}/api/v1/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.contract, 'v1');

  const missing = await fetch(`${base}/api/v1/race/nope`);
  assert.equal(missing.status, 404);
});
