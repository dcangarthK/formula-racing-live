// Headless tiered-telemetry fixture: runs a full 22-car race through the
// production RaceTelemetryRecorder and writes one NDJSON file per tier, then
// checks what a single-car time trial and synthetic unit tests cannot — real
// event coverage, real timing-tower gap strings, and whether the BigQuery
// merge queries in cloud/bigquery/curate.sql read paths that actually exist.
//
// Usage: node tools/sim-telemetry.mjs [trackId] [laps] [outDir]

import fs from 'node:fs';
import path from 'node:path';

// Race incidents use randomness. Pin the harness so the fixture is reproducible.
let randomState = 0x5eed2026;
Math.random = () => {
  randomState |= 0;
  randomState = (randomState + 0x6d2b79f5) | 0;
  let t = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---- minimal DOM stubs (canvas textures) ----
const ctxStub = () => ({
  fillStyle: '#000', strokeStyle: '#000', font: '', textAlign: '', textBaseline: '',
  lineWidth: 1, lineJoin: '',
  fillRect() {}, clearRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, closePath() {}, arcTo() {},
  fillText() {}, strokeText() {}, createLinearGradient: () => ({ addColorStop() {} }),
  createRadialGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
  save() {}, restore() {}, translate() {}, scale() {}, rotate() {},
  ellipse() {}, bezierCurveTo() {}, setTransform() {}, drawImage() {},
});
globalThis.document = {
  createElement: (tag) => tag === 'canvas'
    ? { width: 0, height: 0, getContext: ctxStub }
    : { style: {} },
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const THREE = await import('../lib/three.module.js');
const { buildCircuit } = await import('../js/trackBuilder.js');
const { TRACKS } = await import('../js/tracks.js');
const { RaceSession } = await import('../js/race.js');
const { AIDriver } = await import('../js/ai.js');
const { DRIVERS } = await import('../js/data.js');
const { RaceTelemetryRecorder, TELEMETRY_TIERS } = await import('../js/raceTelemetry.js');

const trackId = process.argv[2] || 'monza';
const laps = +(process.argv[3] || 3);
const outDir = path.resolve(process.argv[4] || 'tools/telemetry-fixture');
const STREAMED = ['live', 'engineering', 'events'];

// The archive tier is roughly 50 KB per sample. Measure it always, but only
// write it out when it is asked for, so a routine run costs tens of MB.
const writeArchive = process.env.TIER_FIXTURE_ARCHIVE === '1';
fs.mkdirSync(outDir, { recursive: true });
const streams = Object.fromEntries(TELEMETRY_TIERS
  .filter(tier => tier !== 'archive' || writeArchive)
  .map(tier => [tier, fs.createWriteStream(path.join(outDir, `${tier}.ndjson`))]));
const stats = Object.fromEntries(TELEMETRY_TIERS.map(tier => [tier, { records: 0, bytes: 0 }]));
// Full tiers are too large to retain; keep only what the assertions inspect.
const events = [];
const liveSamples = [];

const scene = new THREE.Scene();
const circuit = buildCircuit(trackId, TRACKS[trackId], scene);
const session = new RaceSession({
  scene, circuit,
  playerDriverId: DRIVERS[0].id,
  laps, difficulty: 1,
  assists: { tc: true, abs: true, autoGear: true },
  mode: 'race', gridOrder: null,
  onMessage: () => {},
});

const recorder = new RaceTelemetryRecorder({
  sessionId: 'fixture-session', userId: 'fixture-user', userDisplayName: 'Fixture',
  createdAt: '2026-10-19T00:00:00.000Z',
  sessionType: 'race',
  metadata: { gameVersion: '0.1.0', trackId, mode: 'race', trial: false, configuredLaps: laps },
  // The fixture writes the tiers itself; nothing needs a second copy in memory.
  store: { async appendBatch() {}, async readSession() { return []; }, async clearSession() {} },
});

function collect(records) {
  for (const record of records) {
    const line = `${JSON.stringify(record)}\n`;
    stats[record.tier].records += 1;
    stats[record.tier].bytes += Buffer.byteLength(line);
    streams[record.tier]?.write(line);
    if (record.tier === 'events') events.push(record);
    // One live sample per second is enough to exercise every gap-string case.
    if (record.tier === 'live' && stats.live.records % 5 === 0) liveSamples.push(record);
  }
}

collect(recorder.begin(session));

const autopilot = new AIDriver(session.player.phys, circuit,
  { pace: 0.95, consistency: 0.97, racecraft: 0.9 }, 1);
const DT = 1 / 30;
let simT = 0, boxed = false;
const wallClock = Date.now();
while (!session.results && simT < laps * circuit.idealLap * 3 + 300) {
  const input = session.phase === 'racing' && !session.player.finished
    ? autopilot.update(DT, session.entries.map(e => e.phys))
    : { steer: 0, throttle: 0, brake: 0 };
  session.update(DT, input);
  collect(recorder.step(session, DT));
  simT += DT;
  if (!boxed && session.player.lap === 1) { session.playerRequestBox(); boxed = true; }
  if (session.player.pitState && !session.player.pitState.chosen) session.playerChooseTyre('H');
}
// One more step so the classification reaches the event stream.
collect(recorder.step(session, DT));
collect(recorder.end(session, { reason: session.results ? 'classified' : 'abandoned' }));
await Promise.all(Object.values(streams).map(stream => new Promise(resolve => stream.end(resolve))));

const realS = ((Date.now() - wallClock) / 1000).toFixed(1);
const simMinutes = simT / 60;
const mb = bytes => bytes / 1024 / 1024;
console.log(`[tiers] ${trackId} ${laps} laps, 22 cars: ${Math.round(simT)}s sim in ${realS}s real`);
console.log('[tiers] tier          records        MB   MB/30min');
for (const tier of TELEMETRY_TIERS) {
  const { records, bytes } = stats[tier];
  const per30 = mb(bytes) * (30 / simMinutes);
  console.log(`[tiers] ${tier.padEnd(12)} ${String(records).padStart(8)} ${mb(bytes).toFixed(2).padStart(9)} ${per30.toFixed(1).padStart(10)}`);
}
const streamedPer30 = STREAMED.reduce((total, tier) => total + mb(stats[tier].bytes) * (30 / simMinutes), 0);
console.log(`[tiers] streamed total for a 30-minute race: ${streamedPer30.toFixed(1)} MB`);
console.log(`[tiers] fixture written to ${path.relative(process.cwd(), outDir)}`
  + (writeArchive ? '' : ' (archive measured but not written; set TIER_FIXTURE_ARCHIVE=1 to keep it)'));

// ---- assertions ----
let failures = 0;
const fail = (message) => { failures++; console.error(`FAIL: ${message}`); };
const ok = (condition, message) => { if (!condition) fail(message); };

const eventCounts = events.reduce((counts, record) => {
  counts[record.event] = (counts[record.event] || 0) + 1;
  return counts;
}, {});
console.log('[tiers] events:', JSON.stringify(eventCounts));

ok(session.results, 'race did not classify within the simulation budget');
ok(eventCounts.session_started === 1, 'exactly one session_started expected');
ok(eventCounts.session_ended === 1, `exactly one session_ended expected, got ${eventCounts.session_ended}`);
ok(eventCounts.race_finished === 1, 'exactly one race_finished expected');
ok((eventCounts.lap_completed || 0) >= laps, 'lap_completed events missing');
ok((eventCounts.sector_completed || 0) >= 3 * laps, 'sector_completed events missing');
ok((eventCounts.position_changed || 0) > 0, 'no position_changed events in a 22-car race');
ok((eventCounts.pit_entered || 0) > 0, 'no pit_entered events');
ok(eventCounts.pit_entered === eventCounts.pit_exited,
  `pit_entered (${eventCounts.pit_entered}) and pit_exited (${eventCounts.pit_exited}) must pair`);

const ended = events.at(-1);
ok(ended?.event === 'session_ended', 'session_ended must be the last record');
ok(ended?.reason === 'classified', `session_ended reason should be classified, got ${ended?.reason}`);
ok(ended?.completedLaps >= laps, `session_ended completedLaps ${ended?.completedLaps} < ${laps}`);

const classification = events.find(record => record.event === 'race_finished')?.classification || [];
ok(classification.length === 22, `classification must hold 22 cars, got ${classification.length}`);
ok(classification.every(entry => entry.driverId && Number.isFinite(entry.position)),
  'classification entries need a driverId and position');

// Sequence is the ordering and idempotency key across every tier.
let previous = -1;
let ordered = true;
for (const record of events) { if (record.sequence <= previous) ordered = false; previous = record.sequence; }
ok(ordered, 'event sequences must increase');

// Gap strings only produce their lapped and in-pit forms in a real race.
const gapCases = { leader: 0, timed: 0, pit: 0, lapped: 0, nulls: 0 };
for (const sample of liveSamples) {
  for (const car of sample.cars) {
    if (car.position === 1 && car.gapToLeaderSeconds === 0) gapCases.leader++;
    else if (Number.isFinite(car.gapToLeaderSeconds) && car.gapToLeaderSeconds > 0) gapCases.timed++;
    if (car.pitState && car.gapToLeaderSeconds === null) gapCases.pit++;
    if (car.lapsDown > 0) gapCases.lapped++;
    if (car.gapToLeaderSeconds === null && !car.pitState && car.lapsDown === 0) gapCases.nulls++;
  }
}
console.log('[tiers] gap cases:', JSON.stringify(gapCases));
ok(gapCases.leader > 0, 'no leader gap observed');
ok(gapCases.timed > 0, 'no timed gaps observed');
ok(gapCases.nulls === 0, `${gapCases.nulls} live cars had an unparseable gap`);
for (const event of ['car_dnf', 'penalty_changed']) {
  if (!eventCounts[event]) console.warn(`[tiers] WARN: no ${event} occurred; that transition is unverified`);
}
if (!gapCases.pit) console.warn('[tiers] WARN: no in-pit gap sampled; the PIT case is unverified');
if (!gapCases.lapped) console.warn('[tiers] WARN: no lapped car sampled; the +nL case is unverified');

ok(stats.live.records > 0 && stats.engineering.records > 0, 'live and engineering tiers must both be produced');
// live runs at 5 Hz against the 20 Hz engineering tier.
const liveRatio = stats.engineering.records / stats.live.records;
ok(Math.abs(liveRatio - 4) < 0.05, `expected a 4:1 engineering:live ratio, got ${liveRatio.toFixed(3)}`);
ok(stats.archive.records === stats.engineering.records, 'archive and engineering must sample together');

// ---- cloud/bigquery/curate.sql must read paths these records actually have ----
const sql = fs.readFileSync(new URL('../cloud/bigquery/curate.sql', import.meta.url), 'utf8');
const sampleOf = {
  live: JSON.parse(fs.readFileSync(path.join(outDir, 'live.ndjson'), 'utf8').split('\n', 1)[0]),
  engineering: JSON.parse(fs.readFileSync(path.join(outDir, 'engineering.ndjson'), 'utf8').split('\n', 1)[0]),
};

function resolve(value, pointer) {
  return pointer.replace(/^\$\.?/, '').split('.').filter(Boolean)
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), value);
}

// An event record carries only the fields its own event defines, so a path the
// events merge reads has to exist on at least one event, not on every one.
function resolvesOnAnyEvent(pointer) {
  return events.some(record => resolve(record, pointer) !== undefined);
}

function scopeRoot(scope, statement) {
  if (statement.includes('raw_live')) {
    if (scope === 'data') return sampleOf.live;
    if (scope === 'car') return sampleOf.live.cars[0];
  }
  if (statement.includes('raw_engineering')) {
    if (scope === 'data') return sampleOf.engineering;
    if (scope === 'wheel') return sampleOf.engineering.car.wheels[0];
  }
  if (statement.includes('raw_events')) {
    if (scope === 'data') return 'any-event';
  }
  if (statement.includes('race_events')) {
    if (scope === 'payload' && statement.includes("'race_finished'")) {
      return events.find(record => record.event === 'race_finished');
    }
    if (scope === 'entry') return classification[0];
    if (scope === 'payload') {
      return statement.includes("'sector_completed'")
        ? events.find(record => record.event === 'sector_completed')
        : events.find(record => record.event === 'lap_completed');
    }
  }
  return null;
}

let checkedPaths = 0;
for (const statement of sql.split(/;\s*\n/)) {
  // A statement that reads sectors and laps together resolves both scopes.
  const subStatements = statement.includes("'sector_completed'") && statement.includes("'lap_completed'")
    ? statement.split('sectors AS')
    : [statement];
  for (const part of subStatements) {
    for (const [, scope, pointer] of part.matchAll(/JSON_(?:VALUE|QUERY_ARRAY)\((\w+),\s*'(\$[^']*)'\)/g)) {
      const root = scopeRoot(scope, part);
      if (!root) continue;
      checkedPaths++;
      const present = root === 'any-event'
        ? resolvesOnAnyEvent(pointer)
        : resolve(root, pointer) !== undefined;
      if (!present) {
        fail(`curate.sql reads ${scope} ${pointer}, which the fixture's records do not contain`);
      }
    }
  }
}
console.log(`[tiers] curate.sql: ${checkedPaths} JSON paths resolved against real records`);
ok(checkedPaths > 40, `expected to check most curate.sql paths, only matched ${checkedPaths}`);

// Row counts the merge queries would produce.
const liveLines = fs.readFileSync(path.join(outDir, 'live.ndjson'), 'utf8').trimEnd().split('\n');
const carSampleRows = liveLines.reduce((total, line) => total + JSON.parse(line).cars.length, 0);
console.log(`[tiers] car_samples rows=${carSampleRows} laps rows=${eventCounts.lap_completed} results rows=${classification.length}`);
ok(carSampleRows === stats.live.records * 22, 'car_samples must hold one row per car per live record');

process.exitCode = failures ? 1 : 0;
console.log(failures ? `[tiers] FAILED (${failures})` : '[tiers] ALL ASSERTIONS PASSED');
