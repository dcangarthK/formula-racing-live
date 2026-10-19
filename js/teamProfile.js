// A player's own team. The championship always fields eleven constructors, so
// a custom team replaces the player's seat rather than adding a twelfth entry:
// the grid size, the performance spread and every saved championship stay
// valid, and only the identity the player sees — and that reaches telemetry —
// changes.

export const TEAM_PROFILE_KEY = 'formula_racing_live_team_v1';
export const TEAM_PROFILE_VERSION = 1;
export const PLAYER_TEAM_ID = 'apexnine';
export const PLAYER_DRIVER_ID = 'castellane';

export const DEFAULT_TEAM_PROFILE = Object.freeze({
  version: TEAM_PROFILE_VERSION,
  custom: false,
  teamName: 'Apex Nine',
  teamFullName: 'Apex Nine Racing',
  teamCode: 'APX',
  color: 0x111C2E,
  accent: 0x16C7FF,
  driverFirstName: 'Ruben',
  driverLastName: 'Castellane',
  driverCode: 'CAS',
  driverNumber: 26,
});

const MAX_TEAM_NAME = 24;
const MAX_DRIVER_NAME = 18;

function text(value, max, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, max).trim();
  return trimmed || fallback;
}

// Three letters is what the timing tower, the deck lettering and the broadcast
// mark are all laid out for.
export function normalizeCode(value, fallback) {
  const letters = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z]/g, '') : '';
  return letters.length >= 2 ? letters.slice(0, 3).padEnd(3, 'X') : fallback;
}

export function normalizeColor(value, fallback) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) return value;
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) return Number.parseInt(hex, 16);
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return Number.parseInt(hex.split('').map(c => c + c).join(''), 16);
    }
  }
  return fallback;
}

export function toHex(value) {
  return `#${normalizeColor(value, 0).toString(16).padStart(6, '0')}`;
}

// A car number has to stay unique on the grid, so a number another driver
// already carries falls back to the one this seat owns.
export function normalizeNumber(value, takenNumbers = [], fallback = DEFAULT_TEAM_PROFILE.driverNumber) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 99) return fallback;
  return takenNumbers.includes(parsed) ? fallback : parsed;
}

// "Lombard" becomes "Lombard Racing", but "Lombard Racing" is already an
// entrant name and must not become "Lombard Racing Racing".
const ENTRANT_WORD = /\b(racing|motorsport|motorsports|works|collective|syndicate|stable|group|division|team|gp|grand prix|f1|engineering)\b/i;

export function entrantName(teamName) {
  return ENTRANT_WORD.test(teamName) ? teamName : `${teamName} Racing`;
}

export function normalizeTeamProfile(value = {}, { takenNumbers = [] } = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const teamName = text(source.teamName, MAX_TEAM_NAME, DEFAULT_TEAM_PROFILE.teamName);
  const driverLastName = text(source.driverLastName, MAX_DRIVER_NAME, DEFAULT_TEAM_PROFILE.driverLastName);
  return {
    version: TEAM_PROFILE_VERSION,
    custom: !!source.custom,
    teamName,
    teamFullName: text(source.teamFullName, MAX_TEAM_NAME + 12, entrantName(teamName)),
    teamCode: normalizeCode(source.teamCode, DEFAULT_TEAM_PROFILE.teamCode),
    color: normalizeColor(source.color, DEFAULT_TEAM_PROFILE.color),
    accent: normalizeColor(source.accent, DEFAULT_TEAM_PROFILE.accent),
    driverFirstName: text(source.driverFirstName, MAX_DRIVER_NAME, DEFAULT_TEAM_PROFILE.driverFirstName),
    driverLastName,
    driverCode: normalizeCode(source.driverCode, driverLastName.slice(0, 3).toUpperCase().padEnd(3, 'X')),
    driverNumber: normalizeNumber(source.driverNumber, takenNumbers, DEFAULT_TEAM_PROFILE.driverNumber),
  };
}

// The grid's own records are the single source of truth at runtime, so the
// profile is written into them in place. Every consumer — car livery, timing
// tower, championship tables, telemetry — reads the same objects.
export function applyTeamProfile(profile, teams = [], drivers = []) {
  const team = teams.find(entry => entry.id === PLAYER_TEAM_ID);
  const driver = drivers.find(entry => entry.id === PLAYER_DRIVER_ID);
  if (!team || !driver) return { team: null, driver: null };
  const takenNumbers = drivers.filter(entry => entry.id !== PLAYER_DRIVER_ID).map(entry => entry.num);
  const normalized = normalizeTeamProfile(profile, { takenNumbers });

  team.name = normalized.teamName;
  team.fullName = normalized.teamFullName;
  team.code = normalized.teamCode;
  team.color = normalized.color;
  team.accent = normalized.accent;
  driver.firstName = normalized.driverFirstName;
  driver.lastName = normalized.driverLastName;
  driver.code = normalized.driverCode;
  driver.num = normalized.driverNumber;
  return { team, driver, profile: normalized };
}

function defaultStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function createTeamProfileStore({ storage = defaultStorage(), key = TEAM_PROFILE_KEY } = {}) {
  let memory = null;

  function read() {
    if (memory) return memory;
    try {
      const raw = storage?.getItem(key);
      if (raw) memory = normalizeTeamProfile(JSON.parse(raw));
    } catch { memory = null; }
    if (!memory) memory = { ...DEFAULT_TEAM_PROFILE };
    return memory;
  }

  function write(profile) {
    memory = profile;
    try { storage?.setItem(key, JSON.stringify(profile)); } catch { /* private mode: session only */ }
    return memory;
  }

  return {
    get() { return { ...read() }; },
    // A saved profile is always custom, even when every field still matches
    // the default: the player chose it, so the game stops overwriting it.
    save(patch = {}, options = {}) {
      const merged = { ...read(), ...patch, custom: true };
      // A renamed team re-derives its entrant name; the stored one belonged to
      // the previous name and would otherwise shadow it forever.
      if (patch.teamName !== undefined && patch.teamFullName === undefined) delete merged.teamFullName;
      return { ...write(normalizeTeamProfile(merged, options)) };
    },
    reset() {
      memory = { ...DEFAULT_TEAM_PROFILE };
      try { storage?.removeItem(key); } catch { /* nothing to clear */ }
      return { ...memory };
    },
  };
}

export const teamProfileStore = createTeamProfileStore();
