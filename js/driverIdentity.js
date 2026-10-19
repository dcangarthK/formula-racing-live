// Driver identity for telemetry. The opaque identifier is deliberately kept
// separate from the editable display name so renaming a driver never changes
// ownership of their race data.

const PROFILE_KEY = 'formula_racing_live_driver_v1';
const PROFILE_VERSION = 1;
const DEFAULT_DISPLAY_NAME = 'Driver';
const MAX_DISPLAY_NAME_LENGTH = 48;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeDisplayName(value) {
  if (typeof value !== 'string') return DEFAULT_DISPLAY_NAME;
  const normalized = value.trim().replace(/\s+/g, ' ').slice(0, MAX_DISPLAY_NAME_LENGTH).trim();
  return normalized || DEFAULT_DISPLAY_NAME;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function fallbackUuid() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validProfile(value) {
  return value && value.version === PROFILE_VERSION && UUID_PATTERN.test(value.userId);
}

export function createDriverIdentity({
  storage = defaultStorage(),
  generateUuid = fallbackUuid,
  now = () => new Date().toISOString(),
} = {}) {
  let memoryProfile = null;

  function readStoredProfile() {
    try {
      const parsed = JSON.parse(storage?.getItem(PROFILE_KEY) || 'null');
      return validProfile(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeProfile(profile) {
    memoryProfile = profile;
    try {
      storage?.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      // Storage may be unavailable in private browsing or a restricted iframe.
    }
  }

  function getProfile() {
    const existing = memoryProfile || readStoredProfile();
    if (validProfile(existing)) {
      memoryProfile = {
        version: PROFILE_VERSION,
        userId: existing.userId,
        displayName: normalizeDisplayName(existing.displayName),
      };
      return { userId: memoryProfile.userId, displayName: memoryProfile.displayName };
    }

    const userId = generateUuid();
    if (!UUID_PATTERN.test(userId)) throw new TypeError('UUID generator must return a valid UUID');
    writeProfile({ version: PROFILE_VERSION, userId, displayName: DEFAULT_DISPLAY_NAME });
    return { userId, displayName: DEFAULT_DISPLAY_NAME };
  }

  function setDisplayName(displayName) {
    const current = getProfile();
    const next = {
      version: PROFILE_VERSION,
      userId: current.userId,
      displayName: normalizeDisplayName(displayName),
    };
    writeProfile(next);
    return { userId: next.userId, displayName: next.displayName };
  }

  function createSession(sessionType) {
    if (sessionType !== 'race' && sessionType !== 'quali') {
      throw new TypeError('sessionType must be "race" or "quali"');
    }
    const profile = getProfile();
    const sessionId = generateUuid();
    if (!UUID_PATTERN.test(sessionId)) throw new TypeError('UUID generator must return a valid UUID');
    return { ...profile, sessionId, sessionType, startedAt: now() };
  }

  return { getProfile, setDisplayName, createSession };
}

export const driverIdentity = createDriverIdentity();
