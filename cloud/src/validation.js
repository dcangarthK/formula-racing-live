export const SCHEMA_VERSION = 'formula-racing-live.telemetry.v1';
export const SESSION_TYPES = ['race', 'qualifying', 'time_trial'];
// The archive tier is never streamed; it stays in the browser's local store.
export const STREAMED_TIERS = ['live', 'engineering', 'events'];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && ID_PATTERN.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const invalid = (message, field) => { throw new ValidationError(message, field); };

export function validateSessionEnvelope(value) {
  if (!isObject(value)) invalid('JSON object required', '$');
  if (value.schemaVersion !== SCHEMA_VERSION) invalid(`schemaVersion must be ${SCHEMA_VERSION}`, 'schemaVersion');
  if (!validId(value.sessionId)) invalid('invalid sessionId', 'sessionId');
  if (!isObject(value.user) || !validId(value.user.id)) invalid('invalid user.id', 'user.id');
  if (typeof value.user.displayName !== 'string' || value.user.displayName.trim().length > 48) {
    invalid('user.displayName must be a string of at most 48 characters', 'user.displayName');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    invalid('createdAt must be an ISO date-time string', 'createdAt');
  }
  if (value.metadata !== undefined && !isObject(value.metadata)) invalid('metadata must be an object', 'metadata');
  if (value.sessionType !== undefined && !SESSION_TYPES.includes(value.sessionType)) {
    invalid(`sessionType must be one of ${SESSION_TYPES.join(', ')}`, 'sessionType');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: value.sessionId,
    user: { id: value.user.id, displayName: value.user.displayName.trim() },
    game: typeof value.game === 'string' ? value.game.slice(0, 80) : 'Formula Racing Live',
    createdAt: new Date(value.createdAt).toISOString(),
    sessionType: value.sessionType || 'race',
    metadata: value.metadata || {},
  };
}

function validateRecord(record, index, sessionId, userId) {
  const prefix = `records[${index}]`;
  if (!isObject(record)) invalid('record must be an object', prefix);
  if (record.schemaVersion !== SCHEMA_VERSION) invalid('record schemaVersion mismatch', `${prefix}.schemaVersion`);
  if (record.sessionId !== sessionId) invalid('record sessionId does not match token', `${prefix}.sessionId`);
  if (record.userId !== userId) invalid('record userId does not match token', `${prefix}.userId`);
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 0) invalid('sequence must be a non-negative safe integer', `${prefix}.sequence`);
  if (record.recordId !== `${sessionId}:${record.sequence}`) invalid('recordId must equal sessionId:sequence', `${prefix}.recordId`);
  if (record.type !== 'telemetry' && record.type !== 'event') invalid('type must be telemetry or event', `${prefix}.type`);
  if (!finite(record.simulationTimeSeconds) || record.simulationTimeSeconds < 0) invalid('invalid simulationTimeSeconds', `${prefix}.simulationTimeSeconds`);
  if (!finite(record.raceTimeSeconds)) invalid('invalid raceTimeSeconds', `${prefix}.raceTimeSeconds`);
  if (record.tier !== undefined && !STREAMED_TIERS.includes(record.tier)) {
    invalid(`tier must be one of ${STREAMED_TIERS.join(', ')}`, `${prefix}.tier`);
  }
  // The engineering tier carries one car in full detail; live and archive carry
  // every car. A telemetry record must match the shape its tier declares.
  if (record.type === 'telemetry') {
    if (record.tier === 'engineering') {
      if (!isObject(record.car)) invalid('engineering telemetry requires car', `${prefix}.car`);
    } else if (!Array.isArray(record.cars)) {
      invalid('telemetry record requires cars', `${prefix}.cars`);
    }
  }
  if (record.type === 'event' && (typeof record.event !== 'string' || !EVENT_PATTERN.test(record.event))) {
    invalid('event record requires a valid event name', `${prefix}.event`);
  }
}

export function validateBatch(value, tokenPayload, maxRecords) {
  if (!isObject(value)) invalid('JSON object required', '$');
  if (value.schemaVersion !== SCHEMA_VERSION) invalid(`schemaVersion must be ${SCHEMA_VERSION}`, 'schemaVersion');
  if (value.sessionId !== tokenPayload.sid) invalid('sessionId does not match token', 'sessionId');
  if (value.userId !== tokenPayload.sub) invalid('userId does not match token', 'userId');
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > maxRecords) {
    invalid(`records must contain between 1 and ${maxRecords} items`, 'records');
  }
  const seenIds = new Set();
  let previousSequence = -1;
  value.records.forEach((record, index) => {
    validateRecord(record, index, tokenPayload.sid, tokenPayload.sub);
    if (seenIds.has(record.recordId)) invalid('duplicate recordId in batch', `records[${index}].recordId`);
    if (record.sequence <= previousSequence) invalid('records must be ordered by increasing sequence', `records[${index}].sequence`);
    seenIds.add(record.recordId);
    previousSequence = record.sequence;
  });
  return value.records;
}
