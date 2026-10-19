// Formula Racing Live telemetry capture. This module deliberately has no game,
// rendering, or network dependencies: the caller passes the authoritative
// RaceSession after each simulation update.

export const TELEMETRY_SCHEMA_VERSION = 'formula-racing-live.telemetry.v1';

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const optionalFinite = (value) => Number.isFinite(value) ? value : null;
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;

function vector(value) {
  return {
    x: finite(value?.x),
    y: finite(value?.y),
    z: finite(value?.z),
  };
}

function wheelSnapshot(wheel, index) {
  return {
    key: text(wheel?.key, ['FL', 'FR', 'RL', 'RR'][index] || String(index)),
    slipRatio: finite(wheel?.slipRatio),
    slipAngle: finite(wheel?.slipAngle),
    normalLoadN: finite(wheel?.normalLoad),
    surfaceTemperatureC: finite(wheel?.surfaceTemp),
    carcassTemperatureC: finite(wheel?.carcassTemp),
    pressure: finite(wheel?.pressure),
    suspensionDeflectionM: finite(wheel?.suspensionDeflection),
    contact: wheel?.contact !== false,
  };
}

export function serializeRaceEntry(entry = {}) {
  const physics = entry.phys || {};
  const driver = entry.driver || {};
  const team = entry.team || {};
  return {
    driver: {
      id: text(driver.id),
      code: text(driver.code),
      number: optionalFinite(driver.num),
      firstName: text(driver.firstName),
      lastName: text(driver.lastName),
    },
    team: { id: text(team.id || driver.team), name: text(team.name) },
    isPlayer: !!entry.isPlayer,
    race: {
      position: finite(entry.position),
      gridPosition: finite(entry.gridPos),
      lap: finite(entry.lap, -1),
      lastLapSeconds: finite(entry.lastLap),
      bestLapSeconds: finite(entry.bestLap),
      sectorsSeconds: (entry.sectors || []).map(optionalFinite),
      lastSectorsSeconds: (entry.lastSectors || []).map(optionalFinite),
      pitStops: finite(entry.pitStops),
      pitState: entry.pitState ? text(entry.pitState.phase, 'active') : null,
      penaltySeconds: finite(entry.penaltySeconds),
      trackLimits: finite(entry.trackLimits),
      finished: !!entry.finished,
      dnf: !!entry.dnf,
      failureCause: entry.dnf ? text(entry.failureCause, 'retired') : null,
    },
    car: {
      positionM: vector(physics.pos),
      headingRad: finite(physics.heading),
      trackSampleIndex: finite(physics.sampleIdx),
      speedMps: finite(physics.v),
      speedKph: finite(physics.kmh, Math.max(0, finite(physics.v)) * 3.6),
      gear: finite(physics.gear, 1),
      rpmFraction: finite(physics.rpmFrac),
      throttle: finite(physics.throttle),
      brake: finite(physics.brake),
      steering: finite(physics.steer),
      longitudinalAccelerationMps2: finite(physics.longitudinalAcceleration),
      lateralAccelerationMps2: finite(physics.lateralAcceleration),
      yawRateRadPerSecond: finite(physics.yawRate),
      slipAngleRad: finite(physics.slipAngle ?? physics.sideslip),
      downforceN: finite(physics.downforce),
      aeroBalance: finite(physics.aeroBalance, 0.45),
      brakeBias: finite(physics.brakeBias, 0.56),
      brakeTemperatureC: finite(physics.brakeTemp),
      batteryFraction: finite(physics.battery, 1),
      ersMode: finite(physics.ersMode, 1),
      ersDeployW: finite(physics.ersDeploy),
      fuelFraction: finite(physics.fuel, 1),
      tyreCompound: text(physics.compound, 'M'),
      tyreWearFraction: finite(physics.wear),
      tyreGrip: finite(physics.tyreGrip, 1),
      tyreTemperatureC: finite(physics.tyreTemp),
      trackWetness: finite(physics.surface?.wetness),
      offTrack: !!physics.offTrack,
      disabled: !!physics.disabled,
      wheels: Array.isArray(physics.wheels)
        ? physics.wheels.map(wheelSnapshot)
        : [],
    },
  };
}

// A dashboard needs position, gap and tyre state for every car; an engineering
// trace needs everything for one car. Streaming both at full fidelity costs
// roughly 1.9 GB for a 30-minute race, so tiers project the same authoritative
// snapshot at the rate and width each destination actually reads.
export const TELEMETRY_TIERS = ['live', 'engineering', 'events', 'archive'];
export const DEFAULT_LIVE_HZ = 5;

// The timing tower reports gaps as display strings. Parse them back into the
// seconds a query can aggregate, keeping the lapped case distinguishable from
// a car with no measurable gap.
export function parseGapSeconds(value) {
  const raw = text(value).trim();
  if (!raw || raw === 'LEADER') return { seconds: 0, laps: 0 };
  if (raw === 'PIT') return { seconds: null, laps: null };
  const lapped = /^\+(\d+)L$/.exec(raw);
  if (lapped) return { seconds: null, laps: Number(lapped[1]) };
  const seconds = Number.parseFloat(raw.replace('+', ''));
  return { seconds: Number.isFinite(seconds) ? seconds : null, laps: 0 };
}

export function serializeLiveEntry(entry = {}) {
  const physics = entry.phys || {};
  const gap = parseGapSeconds(entry.gapText);
  const interval = parseGapSeconds(entry.intervalText);
  return {
    driverId: text(entry.driver?.id),
    teamId: text(entry.team?.id || entry.driver?.team),
    isPlayer: !!entry.isPlayer,
    position: finite(entry.position),
    lap: finite(entry.lap, -1),
    trackSampleIndex: finite(physics.sampleIdx),
    positionXM: finite(physics.pos?.x),
    positionZM: finite(physics.pos?.z),
    speedKph: finite(physics.kmh, Math.max(0, finite(physics.v)) * 3.6),
    gapToLeaderSeconds: gap.seconds,
    lapsDown: gap.laps,
    intervalSeconds: interval.seconds,
    lastLapSeconds: finite(entry.lastLap),
    bestLapSeconds: finite(entry.bestLap),
    tyreCompound: text(physics.compound, 'M'),
    tyreWearFraction: finite(physics.wear),
    pitState: entry.pitState ? text(entry.pitState.phase, 'active') : null,
    pitStops: finite(entry.pitStops),
    penaltySeconds: finite(entry.penaltySeconds),
    finished: !!entry.finished,
    dnf: !!entry.dnf,
  };
}

export function serializeLiveSession(session = {}) {
  return {
    phase: text(session.phase),
    circuitId: text(session.circuit?.id || session.circuit?.key),
    conditions: {
      wetness: finite(session.conditions?.wetness),
      trackGrip: finite(session.conditions?.trackGrip, 1),
    },
    raceControl: {
      state: text(session.raceControl?.state, 'green'),
      noOvertake: !!session.raceControl?.noOvertake,
    },
    cars: Array.isArray(session.entries) ? session.entries.map(serializeLiveEntry) : [],
  };
}

export function serializePlayerEngineering(session = {}) {
  const entries = Array.isArray(session.entries) ? session.entries : [];
  const player = entries.find(entry => entry.isPlayer) || entries[0];
  if (!player) return null;
  const serialized = serializeRaceEntry(player);
  return {
    phase: text(session.phase),
    circuitId: text(session.circuit?.id || session.circuit?.key),
    driverId: serialized.driver.id,
    teamId: serialized.team.id,
    race: serialized.race,
    car: serialized.car,
  };
}

// Identity that never changes within a session: sent once, with
// `session_started`, instead of in every live sample.
export function serializeRoster(session = {}) {
  const entries = Array.isArray(session.entries) ? session.entries : [];
  return entries.map(entry => ({
    driverId: text(entry.driver?.id),
    code: text(entry.driver?.code),
    number: optionalFinite(entry.driver?.num),
    firstName: text(entry.driver?.firstName),
    lastName: text(entry.driver?.lastName),
    teamId: text(entry.team?.id || entry.driver?.team),
    teamName: text(entry.team?.name),
    isPlayer: !!entry.isPlayer,
    gridPosition: finite(entry.gridPos),
  }));
}

export function serializeRaceSession(session = {}) {
  return {
    mode: text(session.mode, 'race'),
    phase: text(session.phase),
    raceTimeSeconds: finite(session.raceTime),
    configuredLaps: finite(session.laps),
    circuit: {
      id: text(session.circuit?.id || session.circuit?.key),
      // `publicName` is the venue label shown in game; it is defined as a
      // non-enumerable circuit property, so it has to be read explicitly.
      name: text(session.circuit?.publicName || session.circuit?.name || session.circuit?.def?.name),
      lengthM: finite(session.circuit?.length),
    },
    conditions: {
      wetness: finite(session.conditions?.wetness),
      trackGrip: finite(session.conditions?.trackGrip, 1),
    },
    raceControl: {
      state: text(session.raceControl?.state, 'green'),
      noOvertake: !!session.raceControl?.noOvertake,
    },
    cars: Array.isArray(session.entries) ? session.entries.map(serializeRaceEntry) : [],
  };
}

export const SESSION_TYPES = ['race', 'qualifying', 'time_trial'];

// A time trial runs the simulation in `quali` mode, so the raw session mode
// cannot distinguish the two. Callers pass the product-level session type.
export function normalizeSessionType(value, mode = 'race', trial = false) {
  const requested = text(value).trim();
  if (SESSION_TYPES.includes(requested)) return requested;
  if (trial) return 'time_trial';
  return text(mode) === 'quali' ? 'qualifying' : 'race';
}

export function createSessionEnvelope(options = {}) {
  if (!text(options.sessionId).trim()) throw new TypeError('sessionId is required');
  if (!text(options.userId).trim()) throw new TypeError('userId is required');
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    sessionId: options.sessionId.trim(),
    user: {
      id: options.userId.trim(),
      displayName: text(options.userDisplayName).trim(),
    },
    game: text(options.game, 'Formula Racing Live'),
    createdAt: text(options.createdAt, new Date().toISOString()),
    sessionType: normalizeSessionType(
      options.sessionType,
      options.metadata?.mode,
      options.metadata?.trial,
    ),
    metadata: options.metadata && typeof options.metadata === 'object'
      ? JSON.parse(JSON.stringify(options.metadata))
      : {},
  };
}

export class MemoryTelemetryStore {
  constructor() { this.records = []; }
  async appendBatch(records) { this.records.push(...records.map(record => structuredCloneSafe(record))); }
  async readSession(sessionId) {
    return this.records.filter(record => record.sessionId === sessionId).map(structuredCloneSafe);
  }
  async clearSession(sessionId) {
    this.records = this.records.filter(record => record.sessionId !== sessionId);
  }
}

function structuredCloneSafe(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

// Each session holds minutes of multi-car telemetry, so an unbounded store
// grows by hundreds of megabytes across a session of play. Only the newest
// sessions are kept; older ones are deleted when a new session registers.
export const DEFAULT_SESSION_RETENTION = 3;

// Newest first by recorded start time, with the session being recorded always
// kept. Exported so retention is testable without an IndexedDB implementation.
export function selectSessionsToPrune(sessions, keep = DEFAULT_SESSION_RETENTION, protectedId = '') {
  const limit = Math.max(1, Math.floor(keep));
  const ordered = [...sessions].sort((a, b) => {
    const byTime = Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
    return Number.isFinite(byTime) && byTime !== 0
      ? byTime
      : text(b.sessionId).localeCompare(text(a.sessionId));
  });
  const kept = new Set();
  if (text(protectedId)) kept.add(protectedId);
  for (const session of ordered) {
    if (kept.size >= limit) break;
    kept.add(session.sessionId);
  }
  return ordered.filter(session => !kept.has(session.sessionId)).map(session => session.sessionId);
}

export class IndexedDBTelemetryStore {
  constructor(options = {}) {
    this.indexedDB = options.indexedDB || globalThis.indexedDB;
    this.dbName = text(options.dbName, 'formula-racing-live-telemetry');
    this.storeName = text(options.storeName, 'records');
    this.sessionStoreName = text(options.sessionStoreName, 'sessions');
    this.retainSessions = finite(options.retainSessions, DEFAULT_SESSION_RETENTION);
    this._db = null;
    if (!this.indexedDB) throw new Error('IndexedDB is unavailable');
  }

  async _open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'recordId' });
          store.createIndex('sessionId', 'sessionId', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.sessionStoreName)) {
          db.createObjectStore(this.sessionStoreName, { keyPath: 'sessionId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open telemetry database'));
    });
    return this._db;
  }

  async _request(storeName, mode, run) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Telemetry request failed'));
    });
  }

  // Records the session so retention has a start time to order by, then drops
  // the sessions that fall outside the retention window.
  async registerSession(envelope) {
    const sessionId = text(envelope?.sessionId);
    if (!sessionId) return;
    await this._request(this.sessionStoreName, 'readwrite', store => store.put({
      sessionId,
      createdAt: text(envelope.createdAt, new Date().toISOString()),
      sessionType: text(envelope.sessionType),
    }));
    const known = await this._request(this.sessionStoreName, 'readonly', store => store.getAll());
    for (const staleId of selectSessionsToPrune(known, this.retainSessions, sessionId)) {
      await this.clearSession(staleId);
      await this._request(this.sessionStoreName, 'readwrite', store => store.delete(staleId));
    }
  }

  async appendBatch(records) {
    if (!records.length) return;
    const db = await this._open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Unable to persist telemetry'));
      transaction.onabort = () => reject(transaction.error || new Error('Telemetry transaction aborted'));
    });
  }

  async readSession(sessionId) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readonly');
      const index = transaction.objectStore(this.storeName).index('sessionId');
      const request = index.getAll(sessionId);
      request.onsuccess = () => resolve(request.result.sort((a, b) => a.sequence - b.sequence));
      request.onerror = () => reject(request.error || new Error('Unable to read telemetry'));
    });
  }

  async clearSession(sessionId) {
    const db = await this._open();
    const records = await this.readSession(sessionId);
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(this.storeName, 'readwrite');
      const store = transaction.objectStore(this.storeName);
      for (const record of records) store.delete(record.recordId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Unable to clear telemetry'));
    });
  }
}

// Writes to IndexedDB first and only keeps records in memory once IndexedDB is
// unavailable (private mode, quota, browser policy, or open failure). A healthy
// session therefore holds no in-memory duplicate, which a 22-car race cannot
// afford, while a blocked one still finishes without interrupting the race.
export class FallbackTelemetryStore {
  constructor(primary, fallback = new MemoryTelemetryStore()) {
    this.primary = primary;
    this.fallback = fallback;
    this.primaryFailed = false;
  }

  async registerSession(envelope) {
    if (this.primaryFailed) return;
    try { await this.primary.registerSession?.(envelope); }
    catch { this.primaryFailed = true; }
  }

  async appendBatch(records) {
    if (!this.primaryFailed) {
      try {
        await this.primary.appendBatch(records);
        return;
      } catch { this.primaryFailed = true; }
    }
    await this.fallback.appendBatch(records);
  }

  // Records written before IndexedDB failed stay in IndexedDB, so a degraded
  // session is the union of both stores, ordered by sequence.
  async readSession(sessionId) {
    const persisted = [];
    if (!this.primaryFailed) {
      try { return await this.primary.readSession(sessionId); }
      catch { this.primaryFailed = true; }
    } else {
      try { persisted.push(...await this.primary.readSession(sessionId)); }
      catch { /* IndexedDB is gone; the memory fallback is all that is left. */ }
    }
    const byRecordId = new Map();
    for (const record of [...persisted, ...await this.fallback.readSession(sessionId)]) {
      byRecordId.set(record.recordId, record);
    }
    return [...byRecordId.values()].sort((a, b) => a.sequence - b.sequence);
  }

  async clearSession(sessionId) {
    await this.fallback.clearSession(sessionId);
    if (!this.primaryFailed) {
      try { await this.primary.clearSession(sessionId); }
      catch { this.primaryFailed = true; }
    }
  }
}

export function createTelemetryStore(options = {}) {
  const factory = options.indexedDB === undefined ? globalThis.indexedDB : options.indexedDB;
  return factory
    ? new FallbackTelemetryStore(new IndexedDBTelemetryStore({ ...options, indexedDB: factory }))
    : new MemoryTelemetryStore();
}

function entryKey(entry, index) {
  return text(entry?.driver?.id, `entry-${index}`);
}

function eventData(entry) {
  return {
    driverId: text(entry.driver?.id),
    position: finite(entry.position),
    lap: finite(entry.lap, -1),
  };
}

export class RaceTelemetryRecorder {
  constructor(options = {}) {
    this.envelope = createSessionEnvelope(options);
    this.sampleHz = finite(options.sampleHz, 20);
    if (this.sampleHz <= 0 || this.sampleHz > 100) throw new RangeError('sampleHz must be between 0 and 100');
    this.samplePeriod = 1 / this.sampleHz;
    this.liveHz = finite(options.liveHz, DEFAULT_LIVE_HZ);
    if (this.liveHz <= 0 || this.liveHz > this.sampleHz) {
      throw new RangeError('liveHz must be between 0 and sampleHz');
    }
    // Deriving the divisor from the sample rate keeps the tiers phase-locked:
    // every live sample is also an engineering and archive sample.
    this.liveDivisor = Math.max(1, Math.round(this.sampleHz / this.liveHz));
    this.archive = options.archive !== false;
    // `live` and `engineering` are projections of the archive snapshot and are
    // streamed, so persisting them locally would store the same simulation
    // three times. The local copy keeps the full snapshot and the events.
    this.persistTiers = new Set(Array.isArray(options.persistTiers) && options.persistTiers.length
      ? options.persistTiers
      : (this.archive ? ['archive', 'events'] : TELEMETRY_TIERS));
    this.sampleIndex = 0;
    this.store = options.store || createTelemetryStore(options.storage);
    void this.store.registerSession?.(this.envelope);
    this.sequence = 0;
    this.ended = false;
    this.elapsed = 0;
    this.nextSampleAt = this.samplePeriod;
    this.started = false;
    this.raceFinished = false;
    this.previous = new Map();
    this.persistence = Promise.resolve();
    this.persistenceError = null;
  }

  begin(session) {
    if (this.started) return [];
    this.started = true;
    this._prime(session);
    const record = this._record('event', session, {
      event: 'session_started',
      mode: text(session?.mode, 'race'),
      configuredLaps: finite(session?.laps),
      circuit: {
        id: text(session?.circuit?.id || session?.circuit?.key),
        name: text(session?.circuit?.publicName || session?.circuit?.name || session?.circuit?.def?.name),
        lengthM: finite(session?.circuit?.length),
      },
      // The roster is sent once so the live tier can carry ids alone. Without
      // it a consumer has names for no car on the grid.
      roster: serializeRoster(session),
    });
    this._persist([record]);
    return [record];
  }

  step(session, dt) {
    if (!session || !Array.isArray(session.entries)) throw new TypeError('RaceSession with entries is required');
    const delta = finite(dt);
    if (delta < 0) throw new RangeError('dt cannot be negative');
    const records = this.started ? [] : this.begin(session);
    this.elapsed += delta;
    records.push(...this._detectEvents(session));
    // Caller-provided simulation time controls cadence. A large dt may produce
    // more than one scheduled sample; each record is retained in sequence.
    while (this.elapsed + 1e-9 >= this.nextSampleAt) {
      records.push(...this._sampleTiers(session, this.nextSampleAt));
      this.nextSampleAt += this.samplePeriod;
    }
    const newRecords = records.filter(record => record.event !== 'session_started');
    this._persist(newRecords);
    return records;
  }

  // Terminates the stream with an explicit reason and the laps actually
  // completed, which a configured lap count cannot express for a time trial or
  // an abandoned session. Repeat calls are ignored.
  end(session, options = {}) {
    if (this.ended) return [];
    this.ended = true;
    const entries = Array.isArray(session?.entries) ? session.entries : [];
    const completedLaps = entries.reduce(
      (most, entry) => Math.max(most, Array.isArray(entry.lapTimes) ? entry.lapTimes.length : 0),
      0,
    );
    const player = entries.find(entry => entry.isPlayer);
    const reason = text(options.reason).trim()
      || (session?.results ? 'classified' : 'abandoned');
    const record = this._record('event', session, {
      event: 'session_ended',
      reason,
      completedLaps,
      playerCompletedLaps: Array.isArray(player?.lapTimes) ? player.lapTimes.length : 0,
      playerBestLapSeconds: optionalFinite(player?.bestLap),
      classified: !!session?.results,
      durationSeconds: finite(this.elapsed),
    });
    this._persist([record]);
    return [record];
  }

  // One authoritative snapshot, projected into the tiers due at this sample.
  _sampleTiers(session, sampleTime) {
    const records = [];
    const index = this.sampleIndex++;
    if (index % this.liveDivisor === 0) {
      records.push(this._record('telemetry', session, serializeLiveSession(session), sampleTime, 'live'));
    }
    const engineering = serializePlayerEngineering(session);
    if (engineering) {
      records.push(this._record('telemetry', session, engineering, sampleTime, 'engineering'));
    }
    if (this.archive) {
      records.push(this._record('telemetry', session, serializeRaceSession(session), sampleTime, 'archive'));
    }
    return records;
  }

  _prime(session) {
    (session?.entries || []).forEach((entry, index) => {
      const completedLaps = Array.isArray(entry.lapTimes) ? entry.lapTimes.length : 0;
      const sectors = new Set();
      for (let lap = 1; lap <= completedLaps; lap++) {
        sectors.add(`${lap}:1`); sectors.add(`${lap}:2`); sectors.add(`${lap}:3`);
      }
      (entry.sectors || []).forEach((value, sector) => {
        if (Number.isFinite(value)) sectors.add(`${finite(entry.lap, -1) + 1}:${sector + 1}`);
      });
      this.previous.set(entryKey(entry, index), {
        lapTimes: completedLaps,
        sectors,
        position: finite(entry.position),
        pit: !!entry.pitState,
        penalty: finite(entry.penaltySeconds),
        finished: !!entry.finished,
        dnf: !!entry.dnf,
      });
    });
    this.raceFinished = !!session?.results;
  }

  _detectEvents(session) {
    const events = [];
    session.entries.forEach((entry, index) => {
      const key = entryKey(entry, index);
      const before = this.previous.get(key);
      if (!before) { this._prime({ entries: [entry] }); return; }
      const base = eventData(entry);
      const lapTimes = Array.isArray(entry.lapTimes) ? entry.lapTimes : [];
      for (let i = before.lapTimes; i < lapTimes.length; i++) {
        const lapNumber = i + 1;
        events.push(this._event(session, 'lap_completed', {
          ...base, lapNumber, lapTimeSeconds: finite(lapTimes[i]),
          bestLapSeconds: finite(entry.bestLap),
        }));
        if (i === lapTimes.length - 1) {
          (entry.lastSectors || []).forEach((value, sector) => {
            const marker = `${lapNumber}:${sector + 1}`;
            if (Number.isFinite(value) && !before.sectors.has(marker)) {
              events.push(this._event(session, 'sector_completed', {
                ...base, lapNumber, sector: sector + 1, sectorTimeSeconds: value,
              }));
              before.sectors.add(marker);
            }
          });
        }
      }
      (entry.sectors || []).forEach((value, sector) => {
        const lapNumber = finite(entry.lap, -1) + 1;
        const marker = `${lapNumber}:${sector + 1}`;
        if (Number.isFinite(value) && !before.sectors.has(marker)) {
          events.push(this._event(session, 'sector_completed', {
            ...base, lapNumber, sector: sector + 1, sectorTimeSeconds: value,
          }));
          before.sectors.add(marker);
        }
      });
      if (finite(entry.position) !== before.position) {
        events.push(this._event(session, 'position_changed', {
          ...base, from: before.position, to: finite(entry.position),
        }));
      }
      const inPit = !!entry.pitState;
      if (inPit !== before.pit) {
        events.push(this._event(session, inPit ? 'pit_entered' : 'pit_exited', {
          ...base, pitStops: finite(entry.pitStops),
          pitPhase: inPit ? text(entry.pitState?.phase, 'active') : null,
        }));
      }
      const penalty = finite(entry.penaltySeconds);
      if (penalty !== before.penalty) {
        events.push(this._event(session, 'penalty_changed', {
          ...base, previousSeconds: before.penalty, totalSeconds: penalty,
          deltaSeconds: penalty - before.penalty,
        }));
      }
      if (!!entry.finished && !before.finished) {
        events.push(this._event(session, 'car_finished', {
          ...base, finishTimeSeconds: finite(entry.finishTime),
        }));
      }
      if (!!entry.dnf && !before.dnf) {
        events.push(this._event(session, 'car_dnf', {
          ...base, cause: text(entry.failureCause, 'retired'),
          retirementTimeSeconds: finite(entry.retirementTime),
        }));
      }
      before.lapTimes = lapTimes.length;
      before.position = finite(entry.position);
      before.pit = inPit;
      before.penalty = penalty;
      before.finished = !!entry.finished;
      before.dnf = !!entry.dnf;
    });
    if (!!session.results && !this.raceFinished) {
      events.push(this._event(session, 'race_finished', {
        classification: session.results.map(result => ({
          position: finite(result.pos),
          driverId: text(result.driver?.id),
          teamId: text(result.team?.id),
          status: text(result.status),
          laps: finite(result.laps),
          bestLapSeconds: finite(result.bestLap),
          penaltySeconds: finite(result.penaltySeconds),
          points: finite(result.points),
          failureCause: result.failureCause || null,
        })),
      }));
    }
    this.raceFinished = !!session.results;
    return events;
  }

  _event(session, event, data) {
    return this._record('event', session, { event, ...data });
  }

  _record(type, session, payload, sampleTime = this.elapsed, tier = 'events') {
    const sequence = this.sequence++;
    return {
      tier,
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      recordId: `${this.envelope.sessionId}:${sequence}`,
      sessionId: this.envelope.sessionId,
      userId: this.envelope.user.id,
      sequence,
      type,
      sessionType: this.envelope.sessionType,
      simulationTimeSeconds: finite(sampleTime),
      raceTimeSeconds: finite(session?.raceTime),
      ...payload,
    };
  }

  _persist(records) {
    const durable = records.filter(record => this.persistTiers.has(record.tier));
    if (!durable.length) return;
    this.persistence = this.persistence
      .then(() => this.store.appendBatch(durable))
      .catch((error) => { this.persistenceError = error; });
  }

  async flush() {
    await this.persistence;
    if (this.persistenceError) throw this.persistenceError;
  }

  async records() {
    await this.flush();
    return this.store.readSession(this.envelope.sessionId);
  }

  async exportJSON() {
    return JSON.stringify({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      session: this.envelope,
      records: await this.records(),
    }, null, 2) + '\n';
  }

  async exportNDJSON() {
    const header = { type: 'session', ...this.envelope };
    return [header, ...await this.records()].map(record => JSON.stringify(record)).join('\n') + '\n';
  }
}
