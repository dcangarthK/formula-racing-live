// The shapes the dashboards read, and the pure projections that build them
// from telemetry records. A team's serving layer can import this, port it, or
// ignore it entirely — what matters is that `/api/v1/live/:id` emits
// `LiveState` and `/api/v1/race/:id` returns a `RaceReport`.
//
// Everything here is pure and runs in Node and the browser, so the same
// projection can be unit-tested, run in a consumer, or run in the page.

export const CONTRACT_VERSION = 'formula-racing-live.dashboard.v1';

const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);
const text = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

/** @returns an empty LiveState: what a dashboard renders before any record arrives. */
export function createLiveState(sessionId = '') {
  return {
    contractVersion: CONTRACT_VERSION,
    sessionId,
    sessionType: 'race',
    status: 'pending',          // pending | running | finished
    phase: '',
    circuit: { id: '', name: '', lengthM: 0 },
    configuredLaps: null,
    simulationTimeSeconds: 0,
    raceTimeSeconds: 0,
    raceControl: { state: 'green', noOvertake: false },
    conditions: { wetness: 0, trackGrip: 1 },
    roster: {},                 // driverId → identity
    cars: [],                   // ordered by position
    player: null,               // the player's engineering trace, when present
    lastSequence: -1,
    events: [],                 // most recent first, bounded
    endedAt: null,
  };
}

const MAX_EVENT_FEED = 40;

/**
 * Folds one telemetry record into a LiveState. Records may arrive out of
 * order after a retry; anything older than what the state already holds is
 * ignored rather than rewinding the screen.
 */
export function applyRecord(state, record) {
  if (!record || typeof record !== 'object') return state;
  if (record.sessionId && state.sessionId && record.sessionId !== state.sessionId) return state;

  state.sessionId ||= text(record.sessionId);
  state.sessionType = text(record.sessionType, state.sessionType);
  if (Number.isFinite(record.sequence)) state.lastSequence = Math.max(state.lastSequence, record.sequence);

  if (record.tier === 'events') return applyEvent(state, record);

  const stale = finite(record.simulationTimeSeconds) < state.simulationTimeSeconds;
  if (record.tier === 'live' && !stale) {
    state.simulationTimeSeconds = finite(record.simulationTimeSeconds);
    state.raceTimeSeconds = finite(record.raceTimeSeconds);
    state.phase = text(record.phase, state.phase);
    state.raceControl = record.raceControl || state.raceControl;
    state.conditions = record.conditions || state.conditions;
    state.circuit.id ||= text(record.circuitId);
    state.cars = (record.cars || []).map(car => ({
      ...car,
      ...(state.roster[car.driverId] || {}),
      driverId: car.driverId,
    })).sort((a, b) => a.position - b.position);
    if (state.status === 'pending') state.status = 'running';
  }

  if (record.tier === 'engineering' && !stale) {
    state.player = {
      driverId: text(record.driverId),
      teamId: text(record.teamId),
      lap: finite(record.race?.lap, -1),
      simulationTimeSeconds: finite(record.simulationTimeSeconds),
      ...record.car,
    };
  }
  return state;
}

function applyEvent(state, record) {
  switch (record.event) {
    case 'session_started':
      state.status = 'running';
      state.configuredLaps = Number.isFinite(record.configuredLaps) && record.configuredLaps > 0
        ? record.configuredLaps : null;
      state.circuit = record.circuit || state.circuit;
      for (const entry of record.roster || []) state.roster[entry.driverId] = entry;
      break;
    case 'session_ended':
      state.status = 'finished';
      state.endedAt = {
        reason: text(record.reason, 'abandoned'),
        completedLaps: finite(record.completedLaps),
        classified: !!record.classified,
      };
      break;
    default:
      break;
  }
  // A dashboard shows the human-readable stream, not every position swap.
  if (record.event !== 'position_changed') {
    state.events.unshift({
      sequence: record.sequence,
      simulationTimeSeconds: finite(record.simulationTimeSeconds),
      event: text(record.event),
      driverId: text(record.driverId),
      label: eventLabel(record, state.roster),
    });
    state.events.length = Math.min(state.events.length, MAX_EVENT_FEED);
  }
  return state;
}

export function formatLapTime(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(3).padStart(6, '0');
  return minutes > 0 ? `${minutes}:${rest}` : rest;
}

export function eventLabel(record, roster = {}) {
  const who = roster[record.driverId]?.code || record.driverId || '';
  switch (record.event) {
    case 'session_started': return 'Session started';
    case 'lap_completed': return `${who} lap ${record.lapNumber} — ${formatLapTime(record.lapTimeSeconds)}`;
    case 'sector_completed': return `${who} S${record.sector} — ${formatLapTime(record.sectorTimeSeconds)}`;
    case 'pit_entered': return `${who} pits`;
    case 'pit_exited': return `${who} leaves the pits (stop ${record.pitStops})`;
    case 'penalty_changed': return `${who} +${finite(record.deltaSeconds).toFixed(0)}s penalty`;
    case 'car_finished': return `${who} finishes`;
    case 'car_dnf': return `${who} retires — ${text(record.cause, 'mechanical')}`;
    case 'race_finished': return 'Chequered flag';
    case 'session_ended': return `Session ended — ${text(record.reason, 'abandoned')}`;
    default: return text(record.event);
  }
}

/**
 * Builds the post-race report from a session's event records. Events are the
 * source of truth for timing, so a report never disagrees with the race the
 * driver just had.
 */
export function buildRaceReport(events = [], { sessionId = '', sessionType = 'race' } = {}) {
  const started = events.find(record => record.event === 'session_started');
  const ended = events.find(record => record.event === 'session_ended');
  const finished = events.find(record => record.event === 'race_finished');
  const roster = {};
  for (const entry of started?.roster || []) roster[entry.driverId] = entry;

  const laps = [];
  const sectorsByLap = new Map();
  for (const record of events) {
    if (record.event === 'sector_completed') {
      const key = `${record.driverId}:${record.lapNumber}`;
      const sectors = sectorsByLap.get(key) || [null, null, null];
      sectors[record.sector - 1] = finite(record.sectorTimeSeconds);
      sectorsByLap.set(key, sectors);
    }
  }
  for (const record of events) {
    if (record.event !== 'lap_completed') continue;
    laps.push({
      driverId: record.driverId,
      lapNumber: record.lapNumber,
      lapTimeSeconds: finite(record.lapTimeSeconds),
      sectorsSeconds: sectorsByLap.get(`${record.driverId}:${record.lapNumber}`) || [null, null, null],
    });
  }

  const classification = (finished?.classification || []).map(entry => ({
    ...entry,
    ...(roster[entry.driverId] || {}),
    driverId: entry.driverId,
  }));

  const playerId = Object.values(roster).find(entry => entry.isPlayer)?.driverId || '';
  const playerLaps = laps.filter(lap => lap.driverId === playerId);
  const fastest = laps.reduce(
    (best, lap) => (lap.lapTimeSeconds > 0 && (!best || lap.lapTimeSeconds < best.lapTimeSeconds) ? lap : best),
    null,
  );

  return {
    contractVersion: CONTRACT_VERSION,
    sessionId: sessionId || text(started?.sessionId),
    sessionType: text(started?.sessionType, sessionType),
    circuit: started?.circuit || { id: '', name: '', lengthM: 0 },
    configuredLaps: Number.isFinite(started?.configuredLaps) ? started.configuredLaps : null,
    status: ended ? text(ended.reason, 'abandoned') : 'incomplete',
    completedLaps: finite(ended?.completedLaps),
    durationSeconds: finite(ended?.simulationTimeSeconds),
    roster,
    classification,
    laps,
    player: playerId ? playerSummary(playerId, playerLaps, roster) : null,
    fastestLap: fastest ? { ...fastest, driver: roster[fastest.driverId] || null } : null,
    events: events
      .filter(record => !['position_changed', 'sector_completed'].includes(record.event))
      .map(record => ({
        sequence: record.sequence,
        simulationTimeSeconds: finite(record.simulationTimeSeconds),
        event: text(record.event),
        driverId: text(record.driverId),
        label: eventLabel(record, roster),
      })),
    debrief: null, // filled by a team's AI layer, when they build one
  };
}

function playerSummary(driverId, laps, roster) {
  const times = laps.map(lap => lap.lapTimeSeconds).filter(time => time > 0);
  const best = times.length ? Math.min(...times) : 0;
  const mean = times.length ? times.reduce((sum, time) => sum + time, 0) / times.length : 0;
  // Consistency is how tightly the laps cluster around their own mean: 1.0 is
  // a metronome, and anything under about 0.8 is a driver still learning the
  // circuit. Derived here because no single telemetry record contains it.
  const spread = times.length > 1
    ? Math.sqrt(times.reduce((sum, time) => sum + (time - mean) ** 2, 0) / times.length)
    : 0;
  return {
    driverId,
    driver: roster[driverId] || null,
    laps: laps.length,
    bestLapSeconds: best,
    averageLapSeconds: mean,
    consistency: mean > 0 ? Math.max(0, 1 - spread / mean * 10) : 0,
    lapTimes: laps.map(lap => ({ lapNumber: lap.lapNumber, lapTimeSeconds: lap.lapTimeSeconds, sectorsSeconds: lap.sectorsSeconds })),
  };
}
